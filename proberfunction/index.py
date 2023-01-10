import awsapilib
import boto3
import json
import datetime

DEFAULT_RESOURCE_TYPE = 'AWS::::Account'


# This generate an evaluation for config
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

    if rule_parameters["check"] == "pc-billing-compute-optimizer-enabled":
        co_client = boto3.client('compute-optimizer')
        co_enrollment_status = co_client.get_enrollment_status()["status"]
        compliance_value = "COMPLIANT" if co_enrollment_status == "Active" else "NON_COMPLIANT"
    elif rule_parameters["check"] == "invoice-by-email":
        compliance_value = "NON_COMPLIANT"
    else:
        raise


    evaluations.append(build_evaluation(event['accountId'], compliance_value, event, resource_type=DEFAULT_RESOURCE_TYPE))
    AWS_CONFIG_CLIENT.put_evaluations(Evaluations=evaluations, ResultToken=event['resultToken'])