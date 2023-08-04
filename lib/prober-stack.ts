import * as cdk from "aws-cdk-lib";
import { Aws, aws_scheduler } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { JsonPath } from "aws-cdk-lib/aws-stepfunctions";
import * as sfn_tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as lambda_python from "@aws-cdk/aws-lambda-python-alpha";

export class ProberStack extends cdk.Stack {
  private readonly checksWithLambdaBackend = [
    "billing-invoice-by-email-enabled",
    "billing-compute-optimizer-enabled",
    "billing-iam-access-enabled",
    "billing-tax-inheritance-enabled",
    "billing-budget-created",
    "billing-cost-anomaly-detector-created",
    "security-account-is-organizations-management-account",
    "security-account-has-no-iam-users",
  ];

  private readonly allChecks = this.checksWithLambdaBackend.concat([
    "security-iam-root-access-key-check",
    "security-root-account-mfa-enabled",
  ]);

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const proberFunction = new lambda_python.PythonFunction(
      this,
      "proberFunction",
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

    let current: any;
    current = new sfn.Parallel(this, "All jobs");

    for (const probeName of this.checksWithLambdaBackend) {
      current = current.branch(
        new sfn_tasks.LambdaInvoke(this, `prober-${probeName}-invoke`, {
          lambdaFunction: proberFunction,
          payload: sfn.TaskInput.fromObject({
            check: probeName,
          }),
        }).next(
          this.persistProberCheck(
            probeName,
            JsonPath.format("{}", JsonPath.stringAt("$.Payload.compliance"))
          )
        )
      );
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
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/prober/*`,
        ],
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

    this.addCheckEvictions();

    const getAccountSummaryStep = new sfn_tasks.CallAwsService(
      this,
      "getAccountSummary",
      {
        iamResources: ["*"],
        service: "IAM",
        action: "getAccountSummary",
        outputPath: "$.SummaryMap",
      }
    );
    current
      .next(getAccountSummaryStep)
      .next(
        this.persistProberCheck(
          "security-root-account-mfa-enabled",
          JsonPath.format("{}", JsonPath.stringAt("$.AccountMFAEnabled"))
        )
      )
      .next(
        this.persistProberCheck(
          "security-iam-root-access-key-check",
          JsonPath.format("{}", JsonPath.stringAt("$.AccountAccessKeysPresent"))
        )
      );

    const proberStateMachine = new sfn.StateMachine(
      this,
      "proberStateMachine",
      {
        definition: current,
        timeout: cdk.Duration.minutes(1),
      }
    );

    proberDashboardFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["states:StartExecution"],
        resources: [proberStateMachine.stateMachineArn],
        effect: iam.Effect.ALLOW,
      })
    );
    proberDashboardFunction.addEnvironment(
      "PROBER_STATE_MACHINE_ARN",
      proberStateMachine.stateMachineArn
    );
  }

  private persistProberCheck(
    check: string,
    value: string
  ): sfn_tasks.CallAwsService {
    // write output to SSM parameter
    return new sfn_tasks.CallAwsService(this, `persistParameter${check}`, {
      iamResources: [
        `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/prober/*`,
      ],
      service: "SSM",
      action: "putParameter",
      parameters: {
        Name: "/prober/" + check,
        Value: value,
        Type: "String",
        Overwrite: true,
      },
      resultPath: JsonPath.DISCARD,
    });
  }

  private addCheckEvictions() {
    // evict check results every 24 hours
    // this could also be done with dynamic SSM parameters and a Expiration date
    // but currently Step Functions is not capable of calculating dates,
    // so we use a simple scheduler instead
    const checkEvictionRole = new iam.Role(this, "checkEvictionRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      inlinePolicies: {
        account: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["ssm:DeleteParameter"],
              resources: [
                `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/prober/*`,
              ],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
      },
    });
    for (const check of this.allChecks) {
      new aws_scheduler.CfnSchedule(this, `evictCheck${check}`, {
        scheduleExpression: "rate(1 day)",
        flexibleTimeWindow: {
          mode: "FLEXIBLE",
          maximumWindowInMinutes: 1440, // maximum jitter
        },
        target: {
          arn: "arn:aws:scheduler:::aws-sdk:ssm:deleteParameter",
          roleArn: checkEvictionRole.roleArn,
          input: JSON.stringify({
            Name: `/prober/${check}`,
          }),
        },
      });
    }
  }
}
