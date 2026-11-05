import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DataSource, LogEntry, MetricSnapshot, ServiceSummary, UsageRecord } from '@urbani/shared';
import { PersistenceError } from '../../lib/errors';
import { clampPage, compareBinary, compileLike } from '../common';
import type {
  EnvironmentRecord,
  EnvironmentRepository,
  LogFilter,
  LogRepository,
  MetricFilter,
  MetricRepository,
  PageResult,
  ServiceInput,
  ServiceRepository,
  UsageRepository,
} from '../types';
import type { DynamoRepositoryContext } from './index';
import {
  environmentItem,
  itemToEnvironment,
  itemToLog,
  itemToMetric,
  itemToService,
  itemToUsage,
  logItem,
  metricItem,
  serviceItem,
  usageItem,
  type DynamoItem,
  type StoredItem,
} from './items';
import {
  ALERT_PK,
  alertKey,
  alertLinkPk,
  ENVIRONMENT_PK,
  fitsKey,
  LOG_LINK_PREFIX,
  LOG_PK,
  logKey,
  METRIC_PK,
  SERVICE_PK,
  serviceKey,
  USAGE_PK,
  type ItemKey,
} from './keys';
import { removeAlertLink } from './links';
import {
  batchGetAll,
  batchWriteAll,
  CONDITIONAL_CHECK_FAILED,
  isConditionalCheckFailed,
  mapLimit,
  partitionQuery,
  queryAll,
  queryCount,
  send,
  type QueryInput,
} from './ops';
import { APP_TABLE_GSI1 } from './tableDefinition';

/**
 * Telemetry repositories, DynamoDB driver: services, environments, logs, metrics and usage (design §5.3
 * patterns 22–32 and 47). Lists read the whole entity partition and sort in memory with compareBinary.
 */

/** Seed writes replace whole items, last write wins per key (sequential REPLACE). */
function uniqueByKey(items: DynamoItem[]): DynamoItem[] {
  const byKey = new Map<string, DynamoItem>();
  for (const item of items) byKey.set(`${item.PK as string}\u0000${item.SK as string}`, item);
  return [...byKey.values()];
}

export function dynamoServiceRepository(ctx: DynamoRepositoryContext): ServiceRepository {
  /** alertCount counts alerts of any status whose service equals the service name. */
  async function all(): Promise<ServiceSummary[]> {
    const services = await queryAll<StoredItem>(ctx, partitionQuery(SERVICE_PK), 'services.all');
    const alerts = await queryAll<{ service: string }>(
      ctx,
      partitionQuery(ALERT_PK, { projection: '#service', names: { '#service': 'service' } }),
      'services.all',
    );
    const counts = new Map<string, number>();
    for (const a of alerts) counts.set(a.service, (counts.get(a.service) ?? 0) + 1);
    services.sort((x, y) => compareBinary(x.name, y.name) || compareBinary(x.id, y.id));
    return services.map((s) => itemToService(s, counts.get(s.name) ?? 0));
  }

  async function findById(id: string): Promise<ServiceSummary | null> {
    if (!fitsKey(SERVICE_PK, id)) return null;
    const res = await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: serviceKey(id), ConsistentRead: true }),
      'services.findById',
    );
    if (!res.Item) return null;
    const alertCount = await queryCount(
      ctx,
      partitionQuery(ALERT_PK, { filter: '#service = :name', names: { '#service': 'service' }, values: { ':name': res.Item.name } }),
      'services.findById',
    );
    return itemToService(res.Item, alertCount);
  }

  async function count(): Promise<number> {
    return queryCount(ctx, partitionQuery(SERVICE_PK), 'services.count');
  }

  async function upsert(service: ServiceInput, source: DataSource): Promise<void> {
    await send(ctx, new PutCommand({ TableName: ctx.tableName, Item: serviceItem(service, source, ctx.now()) }), 'services.upsert');
  }

  return { all, findById, count, upsert };
}

export function dynamoEnvironmentRepository(ctx: DynamoRepositoryContext): EnvironmentRepository {
  /** Create-only: an existing environment is never overwritten. Only the condition failure is ignored. */
  async function ensure(env: { id: string; name: string }): Promise<void> {
    try {
      await send(
        ctx,
        new PutCommand({
          TableName: ctx.tableName,
          Item: environmentItem(env, ctx.now()),
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': 'PK' },
        }),
        'environments.ensure',
        { handled: [CONDITIONAL_CHECK_FAILED] },
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return;
      throw err;
    }
  }

  async function all(): Promise<EnvironmentRecord[]> {
    const items = await queryAll<StoredItem>(ctx, partitionQuery(ENVIRONMENT_PK), 'environments.all');
    items.sort((x, y) => compareBinary(x.name, y.name) || compareBinary(x.id, y.id));
    return items.map(itemToEnvironment);
  }

  return { ensure, all };
}

/** GSI1 selection of an alert's links whose GSI1SK starts with `prefix` (eventually consistent). */
function alertLinkQuery(alertId: string, prefix: string, extra: { projection?: string; names?: Record<string, string>; descending?: boolean } = {}): QueryInput {
  return {
    IndexName: APP_TABLE_GSI1,
    KeyConditionExpression: '#gsi1pk = :link AND begins_with(#gsi1sk, :prefix)',
    ...(extra.projection ? { ProjectionExpression: extra.projection } : {}),
    ExpressionAttributeNames: { '#gsi1pk': 'GSI1PK', '#gsi1sk': 'GSI1SK', ...extra.names },
    ExpressionAttributeValues: { ':link': alertLinkPk(alertId), ':prefix': prefix },
    ...(extra.descending ? { ScanIndexForward: false } : {}),
  };
}

export function dynamoLogRepository(ctx: DynamoRepositoryContext): LogRepository {
  async function query(filter: LogFilter): Promise<PageResult<LogEntry>> {
    const all = await queryAll<StoredItem>(ctx, partitionQuery(LOG_PK), 'logs.query');
    const like = filter.search ? compileLike(filter.search) : null;
    const matches = all.filter(
      (l) =>
        (!filter.service || l.service === filter.service) &&
        (!filter.environment || l.environment === filter.environment) &&
        (!filter.level || l.level === filter.level) &&
        (!like || like(l.message)),
    );
    matches.sort((x, y) => compareBinary(y.timestamp, x.timestamp) || compareBinary(y.id, x.id));
    const { offset, pageSize } = clampPage(filter.page, filter.pageSize, 50);
    return { items: matches.slice(offset, offset + pageSize).map(itemToLog), total: matches.length };
  }

  /** Newest first: GSI1SK is LOG#<timestamp>#<id>. */
  async function byAlert(alertId: string): Promise<LogEntry[]> {
    if (!fitsKey(ALERT_PK, alertId)) return [];
    const items = await queryAll<StoredItem>(ctx, alertLinkQuery(alertId, LOG_LINK_PREFIX, { descending: true }), 'logs.byAlert');
    return items.map(itemToLog);
  }

  async function clearAlertLinks(alertId: string): Promise<void> {
    if (!fitsKey(ALERT_PK, alertId)) return;
    const op = 'logs.clearAlertLinks';
    const linked = await queryAll<ItemKey>(
      ctx,
      alertLinkQuery(alertId, LOG_LINK_PREFIX, { projection: '#pk, #sk', names: { '#pk': 'PK', '#sk': 'SK' } }),
      op,
    );
    await mapLimit(linked, 8, (key) => removeAlertLink(ctx, key, alertId, op));
  }

  /**
   * Links only logs that exist (LIVE log ids are never persisted, so this is then one call). When at least
   * one exists the alert must exist too, otherwise REFERENCE_NOT_FOUND (SQLite's foreign key, §2.5-8).
   */
  async function linkLogsToAlert(alertId: string, logIds: string[]): Promise<void> {
    if (logIds.length === 0) return;
    const op = 'logs.linkLogsToAlert';
    // An id whose key does not fit was never stored.
    const ids = [...new Set(logIds)].filter((id) => fitsKey(LOG_PK, id));
    if (ids.length === 0) return;
    const existing = await batchGetAll<ItemKey>(ctx, ids.map(logKey), { projection: ['PK', 'SK'] }, op);
    if (existing.length === 0) return;
    const notFound = () => new PersistenceError('REFERENCE_NOT_FOUND', 'Referenced record not found');
    if (!fitsKey(ALERT_PK, alertId)) throw notFound();
    const alert = await send(
      ctx,
      new GetCommand({
        TableName: ctx.tableName,
        Key: alertKey(alertId),
        ConsistentRead: true,
        ProjectionExpression: '#pk',
        ExpressionAttributeNames: { '#pk': 'PK' },
      }),
      op,
    );
    if (!alert.Item) throw notFound();
    await mapLimit(existing, 8, async (key) => {
      try {
        await send(
          ctx,
          new UpdateCommand({
            TableName: ctx.tableName,
            Key: { PK: key.PK, SK: key.SK },
            UpdateExpression: 'SET #alertId = :id, #gsi1pk = :link',
            ConditionExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: { '#alertId': 'alertId', '#gsi1pk': 'GSI1PK', '#pk': 'PK' },
            ExpressionAttributeValues: { ':id': alertId, ':link': alertLinkPk(alertId) },
          }),
          op,
          { handled: [CONDITIONAL_CHECK_FAILED] },
        );
      } catch (err) {
        if (!isConditionalCheckFailed(err)) throw err;
      }
    });
  }

  /** A Put replaces the whole item, so a link is dropped exactly like REPLACE. */
  async function upsertMany(logs: LogEntry[], source: DataSource): Promise<void> {
    const items = uniqueByKey(logs.map((l) => logItem(l, source)));
    await batchWriteAll(ctx, items.map((put) => ({ put })), 'logs.upsertMany');
  }

  return { query, byAlert, clearAlertLinks, linkLogsToAlert, upsertMany };
}

export function dynamoMetricRepository(ctx: DynamoRepositoryContext): MetricRepository {
  /** limit = min(limit ?? 200, 500): a negative limit returns everything (SQLite LIMIT -1), 0 returns []. */
  async function query(filter: MetricFilter): Promise<MetricSnapshot[]> {
    const all = await queryAll<StoredItem>(ctx, partitionQuery(METRIC_PK), 'metrics.query');
    const matches = all.filter(
      (m) => (!filter.service || m.service === filter.service) && (!filter.environment || m.environment === filter.environment),
    );
    matches.sort((x, y) => compareBinary(y.timestamp, x.timestamp) || compareBinary(y.id, x.id));
    const limit = Math.min(filter.limit ?? 200, 500);
    return (limit < 0 ? matches : matches.slice(0, limit)).map(itemToMetric);
  }

  async function upsertMany(metrics: MetricSnapshot[], source: DataSource): Promise<void> {
    const items = uniqueByKey(metrics.map((m) => metricItem(m, source)));
    await batchWriteAll(ctx, items.map((put) => ({ put })), 'metrics.upsertMany');
  }

  return { query, upsertMany };
}

export function dynamoUsageRepository(ctx: DynamoRepositoryContext): UsageRepository {
  /** Newest date first: the SK is <date>#<modelId>. */
  async function all(): Promise<UsageRecord[]> {
    const items = await queryAll<StoredItem>(ctx, partitionQuery(USAGE_PK, { descending: true }), 'usage.all');
    return items.map(itemToUsage);
  }

  /** Keyed by the natural key (date, modelId), last write wins. */
  async function upsertMany(records: UsageRecord[], source: DataSource): Promise<void> {
    const items = uniqueByKey(records.map((u) => usageItem(u, source)));
    await batchWriteAll(ctx, items.map((put) => ({ put })), 'usage.upsertMany');
  }

  return { all, upsertMany };
}
