import { Construct } from 'constructs';
import { aws_dynamodb as dynamodb, aws_iam as iam, aws_kms as kms, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { UrbaniConfig } from '../config';

/** GSI name of the app table. Mirrors packages/backend/src/repositories/dynamodb/tableDefinition.ts. */
export const APP_TABLE_GSI1 = 'GSI1';

/**
 * Persistence (PersistenceConstruct) — the DynamoDB tables.
 *
 * UrbaniAlerts: output table of the planned collector → writer pipeline.
 *   PK service_id (String), SK timestamp (String), GSI anomaly_type-index.
 *   Encrypted at rest with the shared CMK. On-demand billing keeps cost
 *   proportional to the low, bounded write volume (≤288 runs/day).
 *
 * UrbaniApp (`${dynamoTablePrefix}App`, DPI 2): the dashboard backend's data
 *   when DB_DRIVER=dynamodb. Single-table design, PK/SK plus one overloaded
 *   GSI (GSI1PK/GSI1SK). See docs/adr/0001-dynamodb-persistence.md.
 */
export class PersistenceConstruct extends Construct {
  readonly alertsTable: dynamodb.Table;
  readonly appTable: dynamodb.Table;
  private readonly key: kms.IKey;

  constructor(scope: Construct, id: string, cfg: UrbaniConfig, key: kms.IKey) {
    super(scope, id);

    this.alertsTable = new dynamodb.Table(this, 'UrbaniAlerts', {
      tableName: cfg.alertsTable,
      partitionKey: { name: 'service_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecovery: true,
      // RETAIN so alert history is never destroyed by a stack teardown.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.alertsTable.addGlobalSecondaryIndex({
      indexName: cfg.anomalyTypeGsi,
      partitionKey: { name: 'anomaly_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.key = key;
    this.appTable = new dynamodb.Table(this, 'UrbaniApp', {
      tableName: cfg.appTableName,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.RETAIN, // app data is never destroyed by a stack teardown
    });
    this.appTable.addGlobalSecondaryIndex({
      indexName: APP_TABLE_GSI1,
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }

  /** Least-privilege data access for the dashboard backend (no Scan, no admin, no Streams). */
  grantAppDataAccess(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'UrbaniAppTableData',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:BatchWriteItem',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [this.appTable.tableArn, `${this.appTable.tableArn}/index/${APP_TABLE_GSI1}`],
      }),
    );
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'UrbaniAppTableKmsViaDynamoDb',
        actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
        resources: [this.key.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${Stack.of(this).region}.amazonaws.com` } },
      }),
    );
  }
}
