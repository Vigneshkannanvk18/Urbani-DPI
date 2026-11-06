/**
 * Offline template assertions for the DPI 2 app table and the dashboard task role.
 *
 * Synthesizes UrbaniDpiStack in process with aws-cdk-lib (no CDK CLI, no AWS
 * calls, no context lookups) and asserts on the CloudFormation template.
 * Run with `npm run check`. Exits non-zero on the first failed assertion.
 */
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { UrbaniDpiStack } from '../lib/urbani-dpi-stack';
import { APP_TABLE_GSI1 } from '../lib/persistence-construct';

type Resource = { [key: string]: any };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: any };

const APP_DATA_ACTIONS = [
  'dynamodb:GetItem',
  'dynamodb:BatchGetItem',
  'dynamodb:Query',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:ConditionCheckItem',
];
const APP_KMS_ACTIONS = ['kms:Decrypt', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'];

function only(resources: Record<string, Resource>, what: string): [string, Resource] {
  const entries = Object.entries(resources);
  assert.equal(entries.length, 1, `expected exactly one ${what}, found ${entries.length}`);
  return entries[0];
}

const sorted = (a: string | string[]): string[] => [...(Array.isArray(a) ? a : [a])].sort();

function main(): void {
  // 1. Env-agnostic stack: no account/region, so no lookups are needed.
  const stack = new UrbaniDpiStack(new App(), 'UrbaniDpiCheck');
  const template = Template.fromStack(stack);

  // 2. Exactly one UrbaniApp table with the app key schema, CMK, PITR, GSI1 and RETAIN.
  const [appId, app] = only(
    template.findResources('AWS::DynamoDB::Table', { Properties: { TableName: 'UrbaniApp' } }),
    "AWS::DynamoDB::Table with TableName 'UrbaniApp'",
  );
  const ap = app.Properties;
  assert.deepEqual(ap.KeySchema, [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ]);
  assert.equal(ap.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(ap.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled, true);
  assert.equal(ap.SSESpecification?.SSEEnabled, true);
  assert.equal(ap.SSESpecification?.SSEType, 'KMS');
  assert.ok(ap.SSESpecification?.KMSMasterKeyId, 'UrbaniApp SSESpecification has no KMSMasterKeyId');
  assert.equal(ap.GlobalSecondaryIndexes?.length, 1, 'UrbaniApp must have exactly one GSI');
  assert.deepEqual(ap.GlobalSecondaryIndexes[0], {
    IndexName: APP_TABLE_GSI1,
    KeySchema: [
      { AttributeName: 'GSI1PK', KeyType: 'HASH' },
      { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  });
  assert.equal(app.DeletionPolicy, 'Retain');
  assert.equal(app.UpdateReplacePolicy, 'Retain');
  template.hasResource('AWS::DynamoDB::Table', {
    Properties: Match.objectLike({ TableName: 'UrbaniApp', BillingMode: 'PAY_PER_REQUEST' }),
    DeletionPolicy: 'Retain',
  });

  // 3. UrbaniAlerts keeps its key schema and its anomaly_type-index GSI.
  const [alertsId, alerts] = only(
    template.findResources('AWS::DynamoDB::Table', { Properties: { TableName: 'UrbaniAlerts' } }),
    "AWS::DynamoDB::Table with TableName 'UrbaniAlerts'",
  );
  assert.deepEqual(alerts.Properties.KeySchema, [
    { AttributeName: 'service_id', KeyType: 'HASH' },
    { AttributeName: 'timestamp', KeyType: 'RANGE' },
  ]);
  assert.deepEqual(
    alerts.Properties.GlobalSecondaryIndexes.map((g: { IndexName: string }) => g.IndexName),
    ['anomaly_type-index'],
  );
  assert.deepEqual(alerts.Properties.GlobalSecondaryIndexes[0].KeySchema, [
    { AttributeName: 'anomaly_type', KeyType: 'HASH' },
    { AttributeName: 'timestamp', KeyType: 'RANGE' },
  ]);

  // 4. The task role trusts ecs-tasks under aws:SourceAccount; the task definition uses it.
  const [roleId, role] = only(
    template.findResources('AWS::IAM::Role', { Properties: { RoleName: 'UrbaniDashboardTaskRole' } }),
    "AWS::IAM::Role with RoleName 'UrbaniDashboardTaskRole'",
  );
  const trust: Statement[] = role.Properties.AssumeRolePolicyDocument.Statement;
  assert.equal(trust.length, 1, 'the task role must have exactly one trust statement');
  assert.equal(trust[0].Effect, 'Allow');
  assert.equal(trust[0].Action, 'sts:AssumeRole');
  assert.deepEqual((trust[0] as any).Principal, { Service: 'ecs-tasks.amazonaws.com' });
  assert.ok(
    trust[0].Condition?.StringEquals?.['aws:SourceAccount'],
    'the task role trust statement has no aws:SourceAccount condition',
  );
  assert.equal(role.Properties.ManagedPolicyArns, undefined, 'the task role must have no managed policies');
  assert.equal(role.Properties.Policies, undefined, 'the task role must have no inline policies');
  const [, taskDef] = only(template.findResources('AWS::ECS::TaskDefinition'), 'AWS::ECS::TaskDefinition');
  assert.deepEqual(taskDef.Properties.TaskRoleArn, { 'Fn::GetAtt': [roleId, 'Arn'] });

  // 5. Exactly the two FR8.2 statements on the role.
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
    (p.Properties.Roles ?? []).some((r: unknown) => JSON.stringify(r) === JSON.stringify({ Ref: roleId })),
  );
  const statements: Statement[] = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
  assert.equal(statements.length, 2, `expected 2 statements on the task role, found ${statements.length}`);

  const data = statements.find((s) => s.Sid === 'UrbaniAppTableData');
  assert.ok(data, 'statement UrbaniAppTableData is missing');
  assert.equal(data.Effect, 'Allow');
  assert.deepEqual(sorted(data.Action), sorted(APP_DATA_ACTIONS));
  const appArn = { 'Fn::GetAtt': [appId, 'Arn'] };
  assert.deepEqual(data.Resource, [appArn, { 'Fn::Join': ['', [appArn, `/index/${APP_TABLE_GSI1}`]] }]);

  const kmsStmt = statements.find((s) => s.Sid === 'UrbaniAppTableKmsViaDynamoDb');
  assert.ok(kmsStmt, 'statement UrbaniAppTableKmsViaDynamoDb is missing');
  assert.equal(kmsStmt.Effect, 'Allow');
  assert.deepEqual(sorted(kmsStmt.Action), sorted(APP_KMS_ACTIONS));
  const keyRef = ap.SSESpecification.KMSMasterKeyId; // the shared CMK, as the table references it
  assert.deepEqual(kmsStmt.Resource, keyRef);
  assert.deepEqual(kmsStmt.Condition, {
    StringEquals: {
      'kms:ViaService': { 'Fn::Join': ['', ['dynamodb.', { Ref: 'AWS::Region' }, '.amazonaws.com']] },
    },
  });

  const roleJson = JSON.stringify(statements);
  assert.ok(!roleJson.includes(alertsId), 'a task-role statement references the UrbaniAlerts table');
  for (const s of statements) {
    for (const a of sorted(s.Action)) {
      assert.ok(
        !['dynamodb:Scan', 'dynamodb:DescribeTable', 'dynamodb:*'].includes(a),
        `the task role must not grant ${a}`,
      );
    }
  }

  // 6. The backend container still runs DB_DRIVER=sqlite.
  const backend = taskDef.Properties.ContainerDefinitions.find((c: { Name: string }) => c.Name === 'backend');
  assert.ok(backend, 'backend container definition is missing');
  const env: Array<{ Name: string; Value: string }> = backend.Environment ?? [];
  assert.equal(env.find((e) => e.Name === 'DB_DRIVER')?.Value, 'sqlite');

  // 7. Cognito (DPI 2 item 5) is OFF by default and fully absent from the existing stack.
  assert.deepEqual(Object.keys(template.findResources('AWS::Cognito::UserPool')), [], 'Cognito must be off by default');
  // 8. With enableCognito: TOTP MFA required, 4 groups, code grant + PKCE-capable client, hosted domain, Google IdP.
  const cog = new UrbaniDpiStack(
    new App({
      context: {
        enableCognito: 'true',
        cognitoCallbackUrls: 'https://radar.example.test/api/auth/sso/callback',
        cognitoGoogleSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:google-oidc-AbCdEf',
      },
    }),
    'UrbaniDpiCognitoCheck',
  );
  const ct = Template.fromStack(cog);
  ct.hasResourceProperties('AWS::Cognito::UserPool', {
    MfaConfiguration: 'ON',
    EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
  });
  const groups = Object.values(ct.findResources('AWS::Cognito::UserPoolGroup')).map((g: Resource) => g.Properties.GroupName);
  assert.deepEqual(groups.sort(), ['InfraAdmins', 'QaOperators', 'ReadersAuditors', 'SuperAdmins']);
  ct.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    AllowedOAuthFlows: ['code'],
    AllowedOAuthFlowsUserPoolClient: true,
    GenerateSecret: true,
    CallbackURLs: ['https://radar.example.test/api/auth/sso/callback'],
    SupportedIdentityProviders: Match.arrayWith(['COGNITO', 'Google']),
  });
  ct.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'urbani-radar' });
  ct.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', { ProviderType: 'Google' });
  const idp = JSON.stringify(ct.findResources('AWS::Cognito::UserPoolIdentityProvider'));
  assert.ok(idp.includes('resolve:secretsmanager'), 'Google credentials must be Secrets Manager dynamic references');
  for (const o of ['OidcIssuer', 'OidcClientId']) assert.ok(JSON.stringify(ct.toJSON().Outputs).includes(o), `missing output ${o}`);
  console.log(
    'app-table check passed: UrbaniApp table (PK/SK, GSI1, CMK, PITR, Retain), UrbaniAlerts unchanged, ' +
      'UrbaniDashboardTaskRole (ecs-tasks + aws:SourceAccount, 2 statements, no Scan), backend DB_DRIVER=sqlite',
  );
}

try {
  main();
} catch (err) {
  console.error(`app-table check FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
