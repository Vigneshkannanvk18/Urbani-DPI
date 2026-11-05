import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

/**
 * Definition of the single app table (design §5.1, §9.5), used by the local table tooling and the tests.
 * It mirrors the CDK definition in infra/lib/persistence-construct.ts; keep the two in sync.
 */

export const APP_TABLE_GSI1 = 'GSI1';

export function buildCreateTableInput(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
      { AttributeName: 'GSI1PK', AttributeType: 'S' },
      { AttributeName: 'GSI1SK', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: APP_TABLE_GSI1,
        KeySchema: [
          { AttributeName: 'GSI1PK', KeyType: 'HASH' },
          { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  };
}
