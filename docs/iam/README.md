# Radar UrbiNexus (DPI 2): IAM policies for review

Status: **DRAFT for Urbani security review.** Nothing in this folder has been applied to AWS.

These JSON files list the AWS permissions the DPI team needs to build and deploy DPI 2, and the runtime permissions of the components we deploy. Write access is limited to account `701179923456`, region `us-east-1`, and resources whose names start with the DPI prefixes listed below; the few exceptions are listed under "Notes for the security review". Outside DPI resources, access is read-only: describe and list calls, plus log search on the log groups you choose to share (question B2). There is no write access to the monitored applications and no Amazon Bedrock access.

The questions that decide some of these choices (A1, A3, A4, A7, A10, B2, B5, F8) are in [`../DPI2_CLIENT_QUESTIONS.md`](../DPI2_CLIENT_QUESTIONS.md).

## What to attach, and where

**DPI team principal** (the IAM user, role or Identity Center permission set the builders use, question A2):

| File | Create as managed policy | When |
|---|---|---|
| `builder-1-compute-and-delivery.json` | `urbaniqa-dpi2-builder-compute` | Always. Image push, ECS redeploys, 2 tasks plus auto scaling, DNS record for `dpi.urbani.io`, passing the DPI roles to ECS, Lambda and Synthetics. |
| `builder-2-data-and-messaging.json` | `urbaniqa-dpi2-builder-data` | Always. DynamoDB table, SNS alerts topic, SQS dead-letter queue, notifier Lambda, DPI secrets, export and canary buckets. |
| `builder-3-identity-health-logs.json` | `urbaniqa-dpi2-builder-identity` | Always. Cognito user pool, Synthetics canaries, Route 53 health checks, read-only search of the monitored log groups. |
| `builder-4-role-management-option-b.json` | `urbaniqa-dpi2-builder-iam` | Only with Option B. |

**Runtime roles** (your team applies these with Option A; we apply them with Option B):

| File | Applies to |
|---|---|
| `role-task-dpi2-addition.json` | Existing role `urbaniqa-dpi-task-role`, as a new inline policy `dpi2-task-policy`. Keep the DPI 1 inline policy. |
| `role-exec-dpi2-addition.json` | Existing role `urbaniqa-dpi-exec-role`, as a new inline policy `dpi2-secrets-read`. |
| `role-notifier.json` + `trust-lambda.json` | New role `urbaniqa-dpi-notifier-role` (alert notifier Lambda). It reads the stream of your pipeline table `UrbaniAlerts` (question F8). |
| `role-canary.json` + `trust-lambda.json` | New role `urbaniqa-dpi-canary-role` (health check canaries). |
| `permissions-boundary-option-b.json` | Only with Option B. Create it as managed policy `urbaniqa-dpi-boundary`. |

## Option A or Option B (question A3)

- **Option A: your team owns IAM.** You create the two new roles and add the two inline policies from the files above. We get no IAM write access, only `iam:PassRole` on `urbaniqa-dpi-*` roles (in builder-1). Every later role change goes through your team.
- **Option B: delegated, with a permissions boundary.** We can create and edit only roles named `urbaniqa-dpi-*`, and only while the boundary `urbaniqa-dpi-boundary` is attached to them. The boundary is the ceiling: a DPI role can never do more than the boundary allows, whatever policy we attach. We cannot edit or delete the boundary policy, and we cannot remove it from a role. Under this option we also attach the boundary to the two existing DPI 1 roles. The boundary already covers everything those roles use today, so DPI 1 keeps working.

## Names and values these policies assume

| Item | Value |
|---|---|
| Account, region | `701179923456`, `us-east-1` (question A1) |
| Existing DPI 1 resources | Cluster `urbaniqa-qa-observability-cluster`, service `urbaniqa-dpi-svc`, task family `urbaniqa-dpi-task`, ECR `urbaniqa/dpi-frontend` and `urbaniqa/dpi-backend`, log group `/urbani/dpi`, roles `urbaniqa-dpi-exec-role` and `urbaniqa-dpi-task-role`, hosted zone `Z0141203QMOLDPQJCKOF` |
| DynamoDB | DPI table `UrbaniApp` with index `GSI1`. Your pipeline table `UrbaniAlerts`: the notifier reads its stream, and builders can only describe it (question F8). |
| Messaging | SNS topic `urbaniqa-dpi-alerts`, SQS queue `urbaniqa-dpi-notifier-dlq` |
| Lambda | `urbaniqa-dpi-notifier` (and any other function named `urbaniqa-dpi-*`) |
| S3 | `urbaniqa-dpi-exports-701179923456`, `urbaniqa-dpi-canary-701179923456` |
| Secrets | `urbaniqa/dpi/*`, for example `urbaniqa/dpi/slack-webhook`, `urbaniqa/dpi/teams-webhook`, `urbaniqa/dpi/admin-password` |
| Canaries | `urbaniqa-dpi-qa`, `urbaniqa-dpi-main`, `urbaniqa-dpi-payment` |
| Tag | `Project=urbaniqa-dpi` on every DPI 2 resource. The Cognito permissions depend on it. |
| Metric namespace | `Urbani/DPI` (chat latency) |

### One value to replace before you apply

The monitored log groups appear as **`/aws/elasticbeanstalk/urbani-*`** in `builder-3`, `role-task-dpi2-addition` and the boundary. We copied that pattern from our DPI 1 infrastructure code; it is a placeholder. Replace it with the exact QA, Main and Payment log groups you send for question B2. If Main or Payment live in another account or region, see question B3: those ARNs alone are not enough.

## Notes for the security review

- **Secrets:** builders can create and update DPI secrets but cannot read their values; there is no `secretsmanager:GetSecretValue` in the builder policies. Only the runtime roles read secrets. Access to the Urbani API key secret stays exactly as in DPI 1.
- **Deletes are limited:** the builder policies cannot delete the DynamoDB table, the ECS cluster or service, the load balancer or its listener rules, or any Route 53 health check. Item and object deletes are limited to the DPI table and buckets.
- **Your alerts table:** nobody on the DPI side can change `UrbaniAlerts`. Builders can only describe the table and its stream, and the notifier role can only read the stream. Enabling the stream is a one-time setting your team applies (question F8).
- **Exceptions to name scoping:** these permissions cannot be limited to DPI names, either because AWS does not support it for the action or because AWS checks them on the caller. They are CloudWatch alarm create and delete (see auto scaling below), ECS Exec on `backend` containers of the shared cluster (temporary, see below), tagging of Route 53 health checks (their IDs are random), and creating canaries and health checks (the create calls cannot be scoped by name).
- **DNS:** record changes are limited to `dpi.urbani.io` and names under it, with record types A, AAAA and CNAME.
- **Cognito:** we can create a user pool only if it carries the tag `Project=urbaniqa-dpi`, and we can manage only pools with that tag.
- **Auto scaling:** before it registers scaling, Application Auto Scaling checks that the caller may create and delete CloudWatch alarms, so statement `AlarmsCheckedByAutoScaling` uses `"Resource": "*"`. If you would rather not grant it, delete `EcsServiceAutoScaling`, `AutoScalingRead` and `AlarmsCheckedByAutoScaling` from builder-1, and we will send your team the two commands to run once.
- **ECS Exec:** the statements named `TemporaryEcsExecForDpi1DataCopy` (in builder-1 and in the task role addition) are needed only to copy the DPI 1 data out of the running task (question A10). Remove them after the copy. If DPI 2 starts with fresh data, leave them out.
- **Encryption:** the policies assume AWS-managed encryption keys. If you require a customer-managed KMS key (question A7), add the KMS add-on below. Key administration stays with your team.
- **Size:** each builder policy is below the 6,144-character limit for managed policies, and they add three or four managed policies to the principal (IAM allows 10 per user or role by default). With IAM Identity Center, create them as customer managed policies and reference them from the permission set: together they exceed the 10,240-character limit of a permission-set inline policy.
- **How we checked them:** every action, resource ARN and condition key was checked offline against the AWS Service Authorization Reference (October 2026). They have not been run through IAM Access Analyzer `validate-policy`, because we do not have access to your account. We suggest running it when you import them.

## Add-ons (only if your answers require them)

### Customer-managed KMS key (question A7)

Add the first statement to the runtime role policies (task, execution, notifier and canary) and the second to the builder principal. Replace `REPLACE_WITH_KEY_ID`. The key policy must allow IAM policies in this account to grant use of the key; the default key policy does.

```json
{
  "Sid": "UseDpiKeyThroughDpiServices",
  "Effect": "Allow",
  "Action": ["kms:Decrypt", "kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"],
  "Resource": "arn:aws:kms:us-east-1:701179923456:key/REPLACE_WITH_KEY_ID",
  "Condition": {
    "StringEquals": {
      "kms:ViaService": [
        "dynamodb.us-east-1.amazonaws.com",
        "secretsmanager.us-east-1.amazonaws.com",
        "sns.us-east-1.amazonaws.com",
        "sqs.us-east-1.amazonaws.com",
        "s3.us-east-1.amazonaws.com"
      ]
    }
  }
}
```

```json
{
  "Sid": "AttachDpiKeyToNewResources",
  "Effect": "Allow",
  "Action": ["kms:DescribeKey", "kms:CreateGrant", "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*"],
  "Resource": "arn:aws:kms:us-east-1:701179923456:key/REPLACE_WITH_KEY_ID",
  "Condition": {
    "StringEquals": {
      "kms:ViaService": [
        "dynamodb.us-east-1.amazonaws.com",
        "secretsmanager.us-east-1.amazonaws.com",
        "sns.us-east-1.amazonaws.com",
        "sqs.us-east-1.amazonaws.com",
        "s3.us-east-1.amazonaws.com"
      ]
    }
  }
}
```

### Canaries inside a VPC (question B5: private health endpoints)

Add to `role-canary.json`. Route 53 health checks cannot reach private endpoints, so private endpoints are probed only by canaries running in your subnets.

```json
{
  "Sid": "CanaryNetworkInterfacesInVpc",
  "Effect": "Allow",
  "Action": ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface"],
  "Resource": "*"
}
```

### Polling your alerts API instead of the table stream (question F8, option b)

Only if a stream on `UrbaniAlerts` is not possible. A scheduled function then polls your `/alerts` API every few minutes. Add the first two statements to the builder principal and the third to `role-notifier.json`, and remove `ReadPipelineAlertsStream` from that file.

```json
{
  "Sid": "DpiScheduleRules",
  "Effect": "Allow",
  "Action": [
    "events:PutRule", "events:DescribeRule", "events:DeleteRule", "events:EnableRule", "events:DisableRule",
    "events:PutTargets", "events:RemoveTargets", "events:ListTargetsByRule", "events:TagResource"
  ],
  "Resource": "arn:aws:events:us-east-1:701179923456:rule/urbaniqa-dpi-*"
}
```

```json
{
  "Sid": "LetEventBridgeInvokeDpiFunctions",
  "Effect": "Allow",
  "Action": ["lambda:AddPermission", "lambda:RemovePermission"],
  "Resource": "arn:aws:lambda:us-east-1:701179923456:function:urbaniqa-dpi-*",
  "Condition": { "StringEquals": { "lambda:Principal": "events.amazonaws.com" } }
}
```

```json
{
  "Sid": "ReadUrbaniApiKeyForPolling",
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:701179923456:secret:urbaniqa/observability/api-key-*"
}
```

### Deploying with AWS CDK (question A4)

Add to the builder principal. With CDK, CloudFormation creates the resources using the execution policy chosen when the account was bootstrapped, so we suggest bootstrapping with `--cloudformation-execution-policies` set to the three builder policies above instead of the default `AdministratorAccess`.

```json
{
  "Sid": "AssumeCdkBootstrapRoles",
  "Effect": "Allow",
  "Action": "sts:AssumeRole",
  "Resource": "arn:aws:iam::701179923456:role/cdk-hnb659fds-*-role-701179923456-us-east-1"
}
```
