import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AlertLinks } from './items';
import type { DynamoContext } from './client';
import { alertLinkPk, LOG_LINK_PREFIX, METRIC_LINK_PREFIX, type ItemKey } from './keys';
import { CONDITIONAL_CHECK_FAILED, isConditionalCheckFailed, mapLimit, queryAll, send } from './ops';
import { APP_TABLE_GSI1 } from './tableDefinition';

/**
 * Alert links (design §5.4): logs, metrics and analyses carry `alertId` and the sparse GSI1PK
 * `ALERTLINK#<alertId>` while linked. GSI1 reads are eventually consistent and never set ConsistentRead.
 */

/** Removes one link. A condition failure means the item was relinked meanwhile and is ignored. */
export async function removeAlertLink(ctx: DynamoContext, key: ItemKey, alertId: string, op: string): Promise<void> {
  try {
    await send(
      ctx,
      new UpdateCommand({
        TableName: ctx.tableName,
        Key: { PK: key.PK, SK: key.SK },
        UpdateExpression: 'REMOVE #alertId, #gsi1pk',
        ConditionExpression: '#alertId = :id',
        ExpressionAttributeNames: { '#alertId': 'alertId', '#gsi1pk': 'GSI1PK' },
        ExpressionAttributeValues: { ':id': alertId },
      }),
      op,
      { handled: [CONDITIONAL_CHECK_FAILED] },
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) return;
    throw err;
  }
}

/** Unlinks every log, metric and analysis of an alert (SQLite's REPLACE/DELETE cascade, §2.5-1 and -2). */
export async function unlinkAll(ctx: DynamoContext, alertId: string): Promise<void> {
  const op = 'alerts.unlinkAll';
  const linked = await queryAll<ItemKey>(
    ctx,
    {
      IndexName: APP_TABLE_GSI1,
      KeyConditionExpression: '#gsi1pk = :link',
      ProjectionExpression: '#pk, #sk',
      ExpressionAttributeNames: { '#gsi1pk': 'GSI1PK', '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':link': alertLinkPk(alertId) },
    },
    op,
  );
  await mapLimit(linked, 8, (key) => removeAlertLink(ctx, key, alertId, op));
}

/** relatedLogIds / relatedMetricIds of an alert (pattern 16), split by the GSI1SK prefix. */
export async function alertLinks(ctx: DynamoContext, alertId: string, op: string): Promise<AlertLinks> {
  const linked = await queryAll<{ id: string; GSI1SK: string }>(
    ctx,
    {
      IndexName: APP_TABLE_GSI1,
      KeyConditionExpression: '#gsi1pk = :link',
      ProjectionExpression: '#id, #gsi1sk',
      ExpressionAttributeNames: { '#gsi1pk': 'GSI1PK', '#id': 'id', '#gsi1sk': 'GSI1SK' },
      ExpressionAttributeValues: { ':link': alertLinkPk(alertId) },
    },
    op,
  );
  return {
    logIds: linked.filter((i) => i.GSI1SK.startsWith(LOG_LINK_PREFIX)).map((i) => i.id),
    metricIds: linked.filter((i) => i.GSI1SK.startsWith(METRIC_LINK_PREFIX)).map((i) => i.id),
  };
}
