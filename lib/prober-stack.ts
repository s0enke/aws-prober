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


    const rule = new config.ManagedRule(this, 'Prober-RootAccountMFAEnabled', {
      configRuleName: 'prober-root-account-mfa-enabled',
      identifier: 'ROOT_ACCOUNT_MFA_ENABLED',
      description: 'Check if the root account has MFA enabled.',
    });
    rule.node.addDependency(configRecorderIfNotExists);

    const proberFunction =  new lambda_python.PythonFunction(this, 'ProberFunction', {
      entry: 'proberfunction/',
      runtime: lambda.Runtime.PYTHON_3_9,
      timeout: cdk.Duration.seconds(60),
    });

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

    const proberInvoiceByEmailRule = new config.CustomRule(this, 'ProberInvoiceByEmailRule', {
      configRuleName: 'prober-invoice-by-email',
      description: 'My custom Config rule',
      inputParameters: {
        check: 'invoice-by-email',
      },
      lambdaFunction: proberFunction,
      periodic: true,
    });
    proberInvoiceByEmailRule.node.addDependency(configRecorderIfNotExists);



  }
}