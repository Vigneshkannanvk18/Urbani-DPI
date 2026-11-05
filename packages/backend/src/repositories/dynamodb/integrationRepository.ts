import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { compareBinary } from '../common';
import type { IntegrationRepository, IntegrationRow } from '../types';
import type { DynamoRepositoryContext } from './index';
import { integrationItem, itemToIntegration, type StoredItem } from './items';
import { fitsKey, INTEGRATION_PK, integrationKey } from './keys';
import { partitionQuery, queryAll, send } from './ops';

/** Integrations, DynamoDB driver (design §5.3 patterns 37–38). NEVER stores secrets. */
export function dynamoIntegrationRepository(ctx: DynamoRepositoryContext): IntegrationRepository {
  async function all(): Promise<IntegrationRow[]> {
    const items = await queryAll<StoredItem>(ctx, partitionQuery(INTEGRATION_PK), 'integrations.all');
    items.sort((x, y) => compareBinary(x.kind, y.kind) || compareBinary(x.id, y.id));
    return items.map(itemToIntegration);
  }

  async function upsert(row: IntegrationRow): Promise<void> {
    await send(ctx, new PutCommand({ TableName: ctx.tableName, Item: integrationItem(row) }), 'integrations.upsert');
  }

  /** Deleting a missing id is a no-op. */
  async function deleteById(id: string): Promise<void> {
    if (!fitsKey(INTEGRATION_PK, id)) return;
    await send(ctx, new DeleteCommand({ TableName: ctx.tableName, Key: integrationKey(id) }), 'integrations.delete');
  }

  return { all, upsert, delete: deleteById };
}
