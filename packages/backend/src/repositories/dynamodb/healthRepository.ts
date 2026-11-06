import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { HealthCheckResult, HealthRepository } from '../types';
import { healthBucket, parseHealthRange, parseHealthResult, parseReadId } from '../validation';
import type { DynamoRepositoryContext } from './index';
import { healthKey } from './keys';
import { batchWriteAll, partitionQuery, queryAll, queryPage, queryUpTo, send } from './ops';

/**
 * Readiness probe (GET /ready, server start, seed) and service health results (DPI 2 item 9), DynamoDB driver.
 *
 * ping: a strong GetItem of the never-written HEALTH/PING sentinel with a 2 s abort.
 * Results: PK `HEALTHRES#<targetId>`, SK = minute bucket (YYYY-MM-DDTHH:MM), so a repeated write in the same
 * minute overwrites the same item (idempotent). A `HEALTHTARGET` registry item per target lets the retention
 * purge find every target without scanning.
 */
const REGISTRY_PK = 'HEALTHTARGET';
const resultPk = (targetId: string): string => `HEALTHRES#${targetId}`;

type Item = Record<string, unknown>;
const toResult = (i: Item): HealthCheckResult => ({
  targetId: i.targetId as string,
  timestamp: i.timestamp as string,
  status: i.status as HealthCheckResult['status'],
  httpStatus: (i.httpStatus as number | null) ?? null,
  latencyMs: (i.latencyMs as number | null) ?? null,
  error: (i.error as string | null) ?? null,
});

export function dynamoHealthRepository(ctx: DynamoRepositoryContext): HealthRepository {
  async function ping(): Promise<void> {
    await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: healthKey(), ConsistentRead: true }),
      'health.ping',
      { abortSignal: AbortSignal.timeout(2000) },
    );
  }

  async function recordResult(input: HealthCheckResult): Promise<void> {
    const r = parseHealthResult(input);
    await send(
      ctx,
      new PutCommand({
        TableName: ctx.tableName,
        Item: { PK: resultPk(r.targetId), SK: healthBucket(r.timestamp), entityType: 'HEALTH_RESULT', ...r },
      }),
      'health.recordResult',
    );
    await send(
      ctx,
      new PutCommand({
        TableName: ctx.tableName,
        Item: { PK: REGISTRY_PK, SK: r.targetId, entityType: 'HEALTH_TARGET', targetId: r.targetId },
      }),
      'health.registerTarget',
    );
  }

  async function listResults(targetId: string, from: string, to: string, limit?: number): Promise<HealthCheckResult[]> {
    const q = parseHealthRange(targetId, from, to, limit);
    // SK is the minute bucket; the exact bounds are re-checked on the timestamp attribute.
    const items = await queryAll<Item>(
      ctx,
      {
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :fromB AND :toB',
        FilterExpression: '#ts >= :from AND #ts <= :to',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK', '#ts': 'timestamp' },
        ExpressionAttributeValues: {
          ':pk': resultPk(q.targetId), ':fromB': healthBucket(q.from), ':toB': healthBucket(q.to), ':from': q.from, ':to': q.to,
        },
        ConsistentRead: true,
      },
      'health.listResults',
    );
    return items.slice(0, q.limit).map(toResult);
  }
  async function latestResult(targetId: string): Promise<HealthCheckResult | null> {
    const id = parseReadId(targetId);
    const [item] = await queryUpTo<Item>(ctx, partitionQuery(resultPk(id), { descending: true }), 1, 'health.latestResult');
    return item ? toResult(item) : null;
  }

  async function purgeOlderThan(cutoff: string): Promise<number> {
    const targets = await queryAll<{ targetId: string }>(ctx, partitionQuery(REGISTRY_PK), 'health.purgeTargets');
    const cutoffBucket = healthBucket(cutoff);
    let deleted = 0;
    for (const { targetId } of targets) {
      for (;;) {
        const { items: keys } = await queryPage<{ PK: string; SK: string }>(
          ctx,
          {
            KeyConditionExpression: '#pk = :pk AND #sk < :cutoff',
            ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: { ':pk': resultPk(targetId), ':cutoff': cutoffBucket },
            ProjectionExpression: '#pk, #sk',
            ConsistentRead: true,
          },
          200,
          'health.purge',
        );
        if (keys.length === 0) break;
        await batchWriteAll(ctx, keys.map((k) => ({ delete: { PK: k.PK, SK: k.SK } })), 'health.purge');
        deleted += keys.length;
      }
    }
    return deleted;
  }

  return { ping, recordResult, listResults, latestResult, purgeOlderThan };
}
