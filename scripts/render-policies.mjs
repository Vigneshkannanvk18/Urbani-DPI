#!/usr/bin/env node
// Renders the DPI 2 IAM documents from deploy/dpi2.env (no AWS calls, no secret values).
//   node scripts/render-policies.mjs --env deploy/dpi2.env --which exec|task|trust [--kms-arn ARN]
import { parseEnvFile, toMap, ALWAYS_SECRETS, OPTIONAL_SECRETS } from './lib/dpi2-env.mjs';

const GSI = 'GSI1';

export function trustPolicy() {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  };
}

function secretNames(m) {
  const on = (m.ENABLED_OPTIONAL_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of on) if (!OPTIONAL_SECRETS.includes(s)) throw new Error(`ENABLED_OPTIONAL_SECRETS: unknown secret ${s}`);
  return [...ALWAYS_SECRETS, ...on].map((v) => m[`SECRET_NAME_${v}`]).filter(Boolean);
}

/** Execution role: managed policy (ECR pull + log streams) is attached by the script; this is the secrets read. */
export function execPolicy(entries) {
  const m = toMap(entries);
  const { AWS_REGION: region, ACCOUNT_ID: account } = m;
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'ReadDpi2Secrets',
      Effect: 'Allow',
      Action: ['secretsmanager:GetSecretValue'],
      // Secrets Manager appends a random 6-character suffix to the ARN.
      Resource: secretNames(m).map((n) => `arn:aws:secretsmanager:${region}:${account}:secret:${n}-??????`),
    }],
  };
}

/** Task role: DynamoDB table + GSI only, KMS for that key via DynamoDB, and optional SNS / Logs Insights / ECS Exec. */
export function taskPolicy(entries, kmsArn) {
  const m = toMap(entries);
  const { AWS_REGION: region, ACCOUNT_ID: account } = m;
  const table = `arn:aws:dynamodb:${region}:${account}:table/${m.DYNAMODB_TABLE_PREFIX}App`;
  const statements = [
    {
      Sid: 'UrbaniAppTableData',
      Effect: 'Allow',
      Action: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:PutItem',
        'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:ConditionCheckItem'],
      Resource: [table, `${table}/index/${GSI}`],
    },
    {
      Sid: 'UrbaniAppTableKmsViaDynamoDb',
      Effect: 'Allow',
      Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
      Resource: [kmsArn],
      Condition: { StringEquals: { 'kms:ViaService': `dynamodb.${region}.amazonaws.com` } },
    },
  ];
  if (m.ENABLE_SNS === '1') {
    statements.push({
      Sid: 'PublishAlertTopic',
      Effect: 'Allow',
      Action: ['sns:Publish'],
      Resource: [`arn:aws:sns:${region}:${account}:${m.SNS_TOPIC_NAME}`],
    });
    // Read-only "Check connection" on the Notifications page (subscriber counts). Publishes nothing.
    statements.push({
      Sid: 'CheckAlertTopic',
      Effect: 'Allow',
      Action: ['sns:GetTopicAttributes'],
      Resource: [`arn:aws:sns:${region}:${account}:${m.SNS_TOPIC_NAME}`],
    });
  }
  if ((m.LOGS_SOURCE ?? 'default') === 'insights') {
    const groups = (m.LOGS_INSIGHTS_LOG_GROUPS ?? '').split(',').map((p) => p.split('=')[1]?.trim()).filter(Boolean);
    if (groups.length === 0) throw new Error('LOGS_SOURCE=insights needs LOGS_INSIGHTS_LOG_GROUPS');
    statements.push({
      Sid: 'LogsInsightsQueryDeclaredGroups',
      Effect: 'Allow',
      Action: ['logs:StartQuery'],
      Resource: groups.map((g) => `arn:aws:logs:${region}:${account}:log-group:${g}:*`),
    }, {
      Sid: 'LogsInsightsDescribeGroups',
      Effect: 'Allow',
      Action: ['logs:DescribeLogGroups'],
      Resource: groups.map((g) => `arn:aws:logs:${region}:${account}:log-group:${g}:*`),
    }, {
      // AWS does not support resource-level permissions for these two query actions: "*" is required.
      Sid: 'LogsInsightsQueryResults',
      Effect: 'Allow',
      Action: ['logs:GetQueryResults', 'logs:StopQuery'],
      Resource: ['*'],
    });
  }
  if (m.ENABLE_EXEC === '1') {
    statements.push({
      // AWS requires "*" for the SSM Messages channel actions used by ECS Exec.
      Sid: 'EcsExec',
      Effect: 'Allow',
      Action: ['ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'],
      Resource: ['*'],
    });
  }
  return { Version: '2012-10-17', Statement: statements };
}

if (process.argv[1]?.endsWith('render-policies.mjs')) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const which = get('--which');
    let doc;
    if (which === 'trust') doc = trustPolicy();
    else {
      const entries = parseEnvFile(get('--env'));
      doc = which === 'exec' ? execPolicy(entries) : taskPolicy(entries, get('--kms-arn') ?? 'arn:aws:kms:REGION:ACCOUNT:key/KEY_ID');
    }
    process.stdout.write(`${JSON.stringify(doc)}\n`);
  } catch (err) {
    console.error(`render-policies: ${err.message}`);
    process.exit(2);
  }
}
