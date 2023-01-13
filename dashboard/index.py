import boto3

cfg = boto3.client("config")

CATEGORIES = {
    "SECURITY": {
        "rules": {
            "prober-security-iam-root-access-key-check": {
                "title": "No access keys for the AWS account root user exist",
                "description": "It is important to delete all access keys for the root user of an Amazon Web Services "
                               "(AWS) account because they provide permanent access to the account and should not be "
                               "used. The root user is the primary account administrator and has the highest level of "
                               "permissions within an AWS account.",
                "docs": "https://docs.aws.amazon.com/accounts/latest/reference/root-user-access-key.html#root-user"
                        "-delete-access-key",
            },
            "prober-security-root-account-mfa-enabled": {
                "title": "Multi-Factor Authentication (MFA) for the AWS root user account is enabled",
                "description": "Enable Multi-Factor Authentication (MFA) for the AWS root user account to ensure the "
                               "highest level of security for the account with complete administrative rights.",
                "docs": "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_enable_virtual.html"
                        "#enable-virt-mfa-for-root",
            },
            "prober-security-account-has-no-iam-users": {
                "title": "AWS Account has no IAM users",
                "description": "It is recommended to remove all IAM (Identity and Access Management) users and "
                               "instead use Identity Center (AWS SSO) for human access and IAM roles with OIDC or IAM "
                               "Roles Anywhere for machine access outside of AWS. This approach eliminates the need "
                               "to rely on IAM users with permanent passwords and access keys. IAM users are used to "
                               "provide access to the AWS account, but they are associated with long-term credentials "
                               "such as access keys, password and MFA devices. These long-term credentials can become "
                               "compromised if not managed properly, and can also be difficult to revoke or change.",
                "docs": "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_manage.html#id_users_deleting",
            },
            "prober-security-account-is-organizations-management-account": {
                "title": "AWS Organizations is enabled and this is the management account",
                "description": "Set up a secure multi-account environment using AWS Organizations and distribute "
                               "workloads into AWS subaccounts. Additionally, AWS Control Tower can be utilized to "
                               "help with this process (Hint: Control Tower enables AWS services that are not free of "
                               "charge).",
                "docs": "https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/benefits-of"
                        "-using-multiple-aws-accounts.html",
            },
        },
    },
    "COST MANAGEMENT": {
        "rules": {
            "prober-billing-iam-access-enabled": {
                "title": "IAM access to AWS billing and cost management services enabled",
                "description": "Enable IAM access to AWS billing and cost management services, so you can ensure that "
                               "also authorized IAM users and roles have the ability to access these services. This "
                               "is important because it eliminates the need for the root user to be used for daily "
                               "operations.",
                "docs": "https://docs.aws.amazon.com/IAM/latest/UserGuide/tutorial_billing.html",
            },
            "prober-billing-invoice-by-email-enabled": {
                "title": "PDF invoices via email enabled",
                "description": "To ensure timely delivery of invoices, it's important to enable the option for PDF "
                               "invoices to be sent via email. This allows you or your accounting department to "
                               "easily access and manage invoices without having to log in to a separate portal.",
                "docs": "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/emailed-invoice.html",
            },
            "prober-billing-budget-created": {
                "title": "AWS Budget created",
                "description": "Creating a budget and set alerts for when your bill is about to exceed a certain "
                               "threshold. To get a more accurate understanding of your spending, make sure to "
                               "include AWS credits in the settings so that you notice credit burning. Additionally, "
                               "it's a good idea to enable the auto-adjustment feature, which will automatically "
                               "update the budget as your actual bill changes over time.",
                "docs": "https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html",
            },
            "prober-billing-tax-inheritance-enabled": {
                "title": "Tax Inheritance enabled",
                "description": "Enable Tax Inheritance to avoid receiving a separate bill for each AWS member account "
                               "in your AWS Organization.  Usage from AWS member accounts will consolidate to a "
                               "single tax invoice.",
                "docs": "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/manage-account-payment.html"
                        "#manage-account-tax-linked-accounts",
            },
            "prober-billing-cost-anomaly-detector-created": {
                "title": "AWS Cost Anomaly Detection enabled",
                "description": "Enable AWS Cost Anomaly Detection to allow you to detect abnormal spikes or drops in "
                               "your AWS costs early on. This is extremely useful in identifying and troubleshooting "
                               "unexpected increases in your AWS bill. By enabling this feature, you can set up "
                               "alerts and notifications to be triggered when an anomaly is detected, giving you a "
                               "head start in identifying and addressing the issue.",
                "docs": "",
            },
            "prober-billing-compute-optimizer-enabled": {
                "title": "AWS Compute Optimizer enabled",
                "description": "Enable AWS Compute Optimizer to receive recommendations for optimizing the "
                               "performance and cost of your Elastic Compute Cloud (EC2) instances, Lambda functions, "
                               "and Fargate containers. By enabling this service, you can access valuable information "
                               "about how to best use these resources and identify opportunities for rightsizing and "
                               "cost savings.",
                "docs": "https://docs.aws.amazon.com/compute-optimizer/latest/ug/getting-started.html#account-opt-in",
            },
        }

    }
}


def handler(event, context):
    if check_to_recheck := event.get('recheck'):
        cfg.start_config_rules_evaluation(ConfigRuleNames=[check_to_recheck])

    html = ''

    for category, category_config in CATEGORIES.items():
        html += f'<h2 style="margin-top: 40px">{category}</h2>'

        rules = cfg.describe_compliance_by_config_rule(ConfigRuleNames=list(category_config["rules"].keys()))[
            "ComplianceByConfigRules"]

        for rule in rules:
            compliant = rule["Compliance"]["ComplianceType"] == 'COMPLIANT'

            html += f"""
<h3 style="margin-top: 20px">{"✅" if compliant else "❌"} 
{CATEGORIES[category]["rules"][rule["ConfigRuleName"]]["title"]}</h3>
<p>{CATEGORIES[category]["rules"][rule["ConfigRuleName"]]["description"]}</p>

<p>
"""

            if not compliant:
                html += f"""
<a class="btn btn-primary" href="{CATEGORIES[category]["rules"][rule["ConfigRuleName"]]["docs"]}" target="_blank">Fix 
it</a>
"""
            html += f"""
<a class="btn btn-primary">Recheck</a>
<cwdb-action action="call" endpoint="{context.invoked_function_arn}" confirmation="message"> 
   {{ "recheck": "{rule["ConfigRuleName"]}" }}
</cwdb-action> 
</p>
"""

    return html
