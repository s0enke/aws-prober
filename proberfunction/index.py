import os

import boto3
from awsapilib import Billing

billing = Billing(os.environ['AWS_API_LIB_ROLE'])

DEFAULT_RESOURCE_TYPE = 'AWS::::Account'


def handler(event, context):
    rule = event['check']
    aws_account_id = context.invoked_function_arn.split(":")[4]

    if rule == "billing-compute-optimizer-enabled":
        co_client = boto3.client('compute-optimizer')
        co_enrollment_status = co_client.get_enrollment_status()["status"]
        compliance_value = (co_enrollment_status == "Active")
    elif rule == "billing-invoice-by-email-enabled":
        compliance_value = billing.preferences.pdf_invoice_by_mail
    elif rule == "billing-iam-access-enabled":
        compliance_value = billing.iam_access
    elif rule == "billing-tax-inheritance-enabled":
        compliance_value = billing.tax.inheritance
    elif rule == "billing-budget-created":
        budgets_client = boto3.client('budgets')
        compliance_value = True if budgets_client.describe_budgets(AccountId=aws_account_id).get(
            'Budgets') else False
    elif rule == "billing-cost-anomaly-detector-created":
        # check whether a cost anomaly detector is already created
        ce_client = boto3.client('ce')
        compliance_value = True if ce_client.get_anomaly_monitors(MaxResults=1)[
            'AnomalyMonitors'] else False

    elif rule == "security-account-is-organizations-management-account":
        # check aws organization whether the account is the management account
        try:
            organizations_client = boto3.client('organizations')
            account_id = organizations_client.describe_account(AccountId=aws_account_id)['Account']['Id']
            organization_management_account_id = organizations_client.describe_organization()['Organization'][
                'MasterAccountId']
            compliance_value = (account_id == organization_management_account_id)
        except Exception as e:
            compliance_value = False
    elif rule == "security-account-has-no-iam-users":
        iam_client = boto3.client('iam')
        iam_users = iam_client.list_users(MaxItems=1)
        if iam_users['Users']:
            compliance_value = False
        else:
            compliance_value = True
    else:
        raise

    return {
        'compliance': compliance_value,
    }
