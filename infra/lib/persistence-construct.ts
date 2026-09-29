import { Construct } from 'constructs';
import { aws_dynamodb as dynamodb, aws_kms as kms, RemovalPolicy } from 'aws-cdk-lib';
import type { UrbaniConfig } from '../config';

/**
 * Persistence (PersistenceConstruct) — the DynamoDB UrbaniAlerts table.
 *
 * Single-table design matching the documented contract:
 *   PK service_id (String), SK timestamp (String), GSI anomaly_type-index.
 * Encrypted at rest with the shared CMK. On-demand billing keeps cost
 * proportional to the low, bounded write volume (≤288 runs/day).
 */
export class PersistenceConstruct extends Construct {
  readonly alertsTable: dynamodb.Table;

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
  }
}
