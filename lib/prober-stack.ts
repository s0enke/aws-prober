import * as cdk from "aws-cdk-lib";
import { Aws } from "aws-cdk-lib";
import * as config from "aws-cdk-lib/aws-config";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as lambda_python from "@aws-cdk/aws-lambda-python-alpha";

export class ProberStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const serviceLinkedRoleForAwsConfigIfNotExists = new cr.AwsCustomResource(
      this,
      "ServiceLinkedRoleForAwsConfigIfNotExists",
      {
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
        onCreate: {
          action: "createServiceLinkedRole",
          service: "IAM",
          physicalResourceId: cr.PhysicalResourceId.of(
            "ServiceLinkedRoleForAwsConfig"
          ),
          parameters: {
            AWSServiceName: "config.amazonaws.com",
          },
          ignoreErrorCodesMatching: "InvalidInput", // ignore if already created
        },
        installLatestAwsSdk: false,
      }
    );

    // AWS config rules need a recorder to work, so create a dummy recorder with minimum costs if none exists
    const configRecorderIfNotExists = new cr.AwsCustomResource(
      this,
      "ConfigRecorderIfNotExists",
      {
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [
              `arn:aws:iam::${Aws.ACCOUNT_ID}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`,
            ],
            effect: iam.Effect.ALLOW,
          }),
          new iam.PolicyStatement({
            actions: [
              "config:PutConfigurationRecorder",
              "config:DeleteConfigurationRecorder",
            ],
            resources: ["*"],
            effect: iam.Effect.ALLOW,
          }),
        ]),
        onCreate: {
          action: "putConfigurationRecorder",
          service: "ConfigService",
          physicalResourceId: cr.PhysicalResourceId.of(
            "ConfigRecorderIfNotExists"
          ),
          parameters: {
            ConfigurationRecorder: {
              name: "prober",
              recordingGroup: {
                allSupported: false,
                includeGlobalResourceTypes: false,
                resourceTypes: [
                  "Datadog::SLOs::SLO", // some dummy resource type nobody uses
                ],
              },
              roleARN: `arn:aws:iam::${Aws.ACCOUNT_ID}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`,
            },
          },
          ignoreErrorCodesMatching: "MaxNumberOfConfigurationRecordersExceeded", // ignore if already created
        },
        onDelete: {
          action: "deleteConfigurationRecorder",
          service: "ConfigService",
          physicalResourceId: cr.PhysicalResourceId.of(
            "ConfigRecorderIfNotExists"
          ),
          parameters: {
            ConfigurationRecorderName: "prober",
          },
          ignoreErrorCodesMatching: "NoSuchConfigurationRecorder", // ignore if none has been created
        },
        installLatestAwsSdk: false,
      }
    );
    configRecorderIfNotExists.node.addDependency(
      serviceLinkedRoleForAwsConfigIfNotExists
    );

    new config.ManagedRule(this, "prober-security-root-account-mfa-enabled", {
      configRuleName: "prober-security-root-account-mfa-enabled",
      identifier: "ROOT_ACCOUNT_MFA_ENABLED",
    }).node.addDependency(configRecorderIfNotExists);

    new config.ManagedRule(this, "prober-security-iam-root-access-key-check", {
      configRuleName: "prober-security-iam-root-access-key-check",
      identifier: "IAM_ROOT_ACCESS_KEY_CHECK",
    }).node.addDependency(configRecorderIfNotExists);

    const proberFunction = new lambda_python.PythonFunction(
      this,
      "ProberFunction",
      {
        entry: "proberfunction/",
        runtime: lambda.Runtime.PYTHON_3_9,
        timeout: cdk.Duration.seconds(60),
      }
    );
    proberFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "compute-optimizer:GetEnrollmentStatus",
          "organizations:DescribeAccount",
          "organizations:DescribeOrganization",
          "iam:ListUsers",
          "budgets:ViewBudget",
          "ce:GetAnomalyMonitors",
        ],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    const awsApiLibRole = new iam.Role(this, "AwsApiLibRole", {
      assumedBy: new iam.ArnPrincipal(proberFunction.role?.roleArn!),
      inlinePolicies: {
        account: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["tax:Get*", "billing:Get*", "aws-portal:View*"],
              resources: ["*"],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
      },
    });
    proberFunction.addEnvironment("AWS_API_LIB_ROLE", awsApiLibRole.roleArn);

    for (let probeName of [
      "billing-invoice-by-email-enabled",
      "billing-compute-optimizer-enabled",
      "billing-iam-access-enabled",
      "billing-tax-inheritance-enabled",
      "billing-budget-created",
      "billing-cost-anomaly-detector-created",
      "security-account-is-organizations-management-account",
      "security-account-has-no-iam-users",
    ]) {
      new config.CustomRule(this, `prober-${probeName}`, {
        configRuleName: `prober-${probeName}`,
        inputParameters: {
          check: probeName,
        },
        lambdaFunction: proberFunction,
        periodic: true,
      }).node.addDependency(configRecorderIfNotExists);
    }

    const proberDashboard = new cloudwatch.Dashboard(this, "proberDashboard", {
      dashboardName: "aws-prober",
    });

    const proberDashboardFunction = new lambda_python.PythonFunction(
      this,
      "proberDashboardFunction",
      {
        entry: "dashboard/",
        runtime: lambda.Runtime.PYTHON_3_9,
        timeout: cdk.Duration.seconds(60),
      }
    );
    proberDashboardFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["config:Describe*", "config:StartConfigRulesEvaluation"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    // Create a custom widget for the dashboard
    const customWidget = new cloudwatch.CustomWidget({
      functionArn: proberDashboardFunction.functionArn,
      title: "",
      width: 24,
      height: 40,
    });

    proberDashboard.addWidgets(customWidget);
  }
}
