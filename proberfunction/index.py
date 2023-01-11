import boto3
import json
from awsapilib import Billing
import os

billing = Billing(os.environ['AWS_API_LIB_ROLE'])

DEFAULT_RESOURCE_TYPE = 'AWS::::Account'


def build_evaluation(resource_id, compliance_type, event, resource_type=DEFAULT_RESOURCE_TYPE, annotation=None):
    """Form an evaluation as a dictionary. Usually suited to report on scheduled rules.
    Keyword arguments:
    resource_id -- the unique id of the resource to report
    compliance_type -- either COMPLIANT, NON_COMPLIANT or NOT_APPLICABLE
    event -- the event variable given in the lambda handler
    resource_type -- the CloudFormation resource type (or AWS::::Account) to report on the rule (default DEFAULT_RESOURCE_TYPE)
    annotation -- an annotation to be added to the evaluation (default None)
    """
    eval_cc = {}
    if annotation:
        eval_cc['Annotation'] = annotation
    eval_cc['ComplianceResourceType'] = resource_type
    eval_cc['ComplianceResourceId'] = resource_id
    eval_cc['ComplianceType'] = compliance_type
    eval_cc['OrderingTimestamp'] = str(json.loads(event['invokingEvent'])['notificationCreationTime'])
    return eval_cc

def handler(event, context):

    evaluations = []
    rule_parameters = json.loads(event['ruleParameters'])

    AWS_CONFIG_CLIENT = boto3.client("config")

    if rule_parameters["check"] == "billing-compute-optimizer-enabled":
        co_client = boto3.client('compute-optimizer')
        co_enrollment_status = co_client.get_enrollment_status()["status"]
        compliance_value = "COMPLIANT" if co_enrollment_status == "Active" else "NON_COMPLIANT"
    elif rule_parameters["check"] == "billing-invoice-by-email-enabled":
        compliance_value = "COMPLIANT" if billing.preferences.pdf_invoice_by_mail else "NON_COMPLIANT"
    elif rule_parameters["check"] == "billing-iam-access-enabled":
        compliance_value = "COMPLIANT" if billing.iam_access else "NON_COMPLIANT"
    elif rule_parameters["check"] == "billing-tax-inheritance-enabled":
        compliance_value = "COMPLIANT" if billing.tax.inheritance else "NON_COMPLIANT"
    elif rule_parameters["check"] == "billing-budget-created":
        budgets_client = boto3.client('budgets')
        compliance_value = "COMPLIANT" if budgets_client.describe_budgets(AccountId=event['accountId'])['Budgets'] else "NON_COMPLIANT"
    elif rule_parameters["check"] == "security-account-is-organizations-management-account":
        # check aws organization whether the account is the management account
        try:
            organizations_client = boto3.client('organizations')
            account_id = organizations_client.describe_account(AccountId=event['accountId'])['Account']['Id']
            organization_management_account_id = organizations_client.describe_organization()['Organization']['MasterAccountId']
            compliance_value = "COMPLIANT" if account_id == organization_management_account_id else "NON_COMPLIANT"
        except:
            compliance_value = "NON_COMPLIANT"
    elif rule_parameters["check"] == "security-account-has-no-iam-users":
        iam_client = boto3.client('iam')
        iam_users = iam_client.list_users(MaxItems=1)
        if iam_users['Users']:
            compliance_value = "NON_COMPLIANT"
        else:
            compliance_value = "COMPLIANT"
    else:
        raise

    evaluations.append(build_evaluation(event['accountId'], compliance_value, event, resource_type=DEFAULT_RESOURCE_TYPE))
    AWS_CONFIG_CLIENT.put_evaluations(Evaluations=evaluations, ResultToken=event['resultToken'])