import * as cdk from 'aws-cdk-lib';
import * as config from 'aws-cdk-lib/aws-config';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_python from '@aws-cdk/aws-lambda-python-alpha';
import {Aws} from "aws-cdk-lib";

export class ProberStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const serviceLinkedRoleForAwsConfigIfNotExists = new cr.AwsCustomResource(this, 'ServiceLinkedRoleForAwsConfigIfNotExists', {
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      onCreate: {
        action: 'createServiceLinkedRole',
        service: 'IAM',
        physicalResourceId: cr.PhysicalResourceId.of('ServiceLinkedRoleForAwsConfig'),
        parameters: {
          AWSServiceName: 'config.amazonaws.com',
        },
        ignoreErrorCodesMatching: 'InvalidInput', // ignore if already created
      },
    });

    // AWS config rules need a recorder to work, so create a dummy recorder with minimum costs if none exists
    const configRecorderIfNotExists = new cr.AwsCustomResource(this, 'ConfigRecorderIfNotExists', {
      policy: cr.AwsCustomResourcePolicy.fromStatements(
        [
          new iam.PolicyStatement({
            actions: ['iam:PassRole', 'config:PutConfigurationRecorder', 'config:DeleteConfigurationRecorder'],
            resources: ['*'],
            effect: iam.Effect.ALLOW
          })
        ],
      ),
      onCreate: {
        action: 'putConfigurationRecorder',
        service: 'ConfigService',
        physicalResourceId: cr.PhysicalResourceId.of('ConfigRecorderIfNotExists'),
        parameters: {
          ConfigurationRecorder: {
            name: 'prober',
            recordingGroup: {
              allSupported: false,
              includeGlobalResourceTypes: false,
              resourceTypes: [
                'Datadog::SLOs::SLO', // some dummy resource type nobody uses
              ],
            },
            roleARN: `arn:aws:iam::${Aws.ACCOUNT_ID}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`,
          }
        },
        ignoreErrorCodesMatching: 'MaxNumberOfConfigurationRecordersExceeded', // ignore if already created
      },
      onDelete: {
        action: 'deleteConfigurationRecorder',
        service: 'ConfigService',
        physicalResourceId: cr.PhysicalResourceId.of('ConfigRecorderIfNotExists'),
        parameters: {
          ConfigurationRecorderName: 'prober',
        },
      }
    });
    configRecorderIfNotExists.node.addDependency(serviceLinkedRoleForAwsConfigIfNotExists);


    new config.ManagedRule(this, 'prober-security-root-account-mfa-enabled', {
      configRuleName: 'prober-security-root-account-mfa-enabled',
      identifier: 'ROOT_ACCOUNT_MFA_ENABLED',
    }).node.addDependency(configRecorderIfNotExists);

    new config.ManagedRule(this, 'prober-security-iam-root-access-key-check', {
      configRuleName: 'prober-iam-root-access-key-check',
      identifier: 'IAM_ROOT_ACCESS_KEY_CHECK',
    }).node.addDependency(configRecorderIfNotExists);

    const proberFunction =  new lambda_python.PythonFunction(this, 'ProberFunction', {
      entry: 'proberfunction/',
      runtime: lambda.Runtime.PYTHON_3_9,
      timeout: cdk.Duration.seconds(60),
    });
    proberFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['compute-optimizer:GetEnrollmentStatus', 'organizations:DescribeAccount', 'organizations:DescribeOrganization', 'iam:ListUsers'],
      resources: ['*'],
      effect: iam.Effect.ALLOW
      })
    );

    const awsApiLibRole = new iam.Role(this, 'AwsApiLibRole', {
      assumedBy: new iam.ArnPrincipal(proberFunction.role?.roleArn!),
      inlinePolicies: {
        'account': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['*'],
              resources: ['*'],
              effect: iam.Effect.ALLOW
            })
          ]
        })
      }
    });
    proberFunction.addEnvironment('AWS_API_LIB_ROLE', awsApiLibRole.roleArn);

    new config.CustomRule(this, 'prober-billing-invoice-by-email-enabled', {
      configRuleName: 'prober-billing-invoice-by-email-enabled',
      inputParameters: {
        check: 'invoice-by-email',
      },
      lambdaFunction: proberFunction,
      periodic: true,
    }).node.addDependency(configRecorderIfNotExists);

    new config.CustomRule(this, 'prober-billing-compute-optimizer-enabled', {
      configRuleName: 'prober-billing-compute-optimizer-enabled',
      inputParameters: {
        check: 'billing-compute-optimizer-enabled',
      },
      lambdaFunction: proberFunction,
      periodic: true,
    }).node.addDependency(configRecorderIfNotExists);

    new config.CustomRule(this, 'prober-billing-iam-access-enabled', {
      configRuleName: 'prober-billing-iam-access-enabled',
      inputParameters: {
        check: 'billing-iam-access-enabled',
      },
      lambdaFunction: proberFunction,
      periodic: true,
    }).node.addDependency(configRecorderIfNotExists);

    new config.CustomRule(this, 'prober-billing-tax-inheritance-enabled', {
      configRuleName: 'prober-billing-tax-inheritance-enabled',
      inputParameters: {
        check: 'billing-tax-inheritance-enabled',
      },
      lambdaFunction: proberFunction,
      periodic: true,
    }).node.addDependency(configRecorderIfNotExists);

    new config.CustomRule(this, 'prober-security-account-is-organizations-management-account', {
      configRuleName: 'prober-security-account-is-organizations-management-account',
      inputParameters: {
        check: 'security-account-is-organizations-management-account',
      },
      lambdaFunction: proberFunction,
      periodic: true,
    }).node.addDependency(configRecorderIfNotExists);

    new config.CustomRule(this, 'prober-security-account-has-no-iam-users', {
      configRuleName: 'prober-security-account-has-no-iam-users',
      inputParameters: {
        check: 'security-account-has-no-iam-users',
      },
      lambdaFunction: proberFunction,
      periodic: true,
    }).node.addDependency(configRecorderIfNotExists);

  }
}