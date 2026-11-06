import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AlertStatus, DataSource, PersistedAlert, UrbaniIncidentAlert } from '@urbani/shared';
import { PersistenceError } from '../../lib/errors';
import { clampPage, compareBinary, compileLike } from '../common';
import type { AlertFilter, AlertRepository, PageResult } from '../types';
import type { DynamoRepositoryContext } from './index';
import { alertItem, budgetEvidence, itemToAlert, type StoredItem } from './items';
import { ALERT_PK, alertKey, alertSourcePk, fitsKey } from './keys';
import { alertLinks, unlinkAll } from './links';
import {
  CONDITIONAL_CHECK_FAILED,
  isConditionalCheckFailed,
  mapLimit,
  partitionQuery,
  queryAll,
  queryCount,
  send,
} from './ops';
import { APP_TABLE_GSI1 } from './tableDefinition';

/**
 * Alert repository, DynamoDB driver (design §5.3 patterns 14–21, §5.4). Alerts live in the `ALERT`
 * partition with evidence and recommended actions inline; links to logs, metrics and analyses are the
 * sparse GSI1 `ALERTLINK#<alertId>` entries.
 */

/** Attributes of the live-upsert item that the update never writes (§5.4): the keys and the lifecycle. */
const LIVE_UPSERT_SKIPPED = new Set(['PK', 'SK', 'status', 'acknowledgedBy', 'acknowledgedAt']);

const ACTIVE_FILTER = '#status IN (:open, :ack)';
const ACTIVE_VALUES = { ':open': 'OPEN', ':ack': 'ACKNOWLEDGED' };

export function dynamoAlertRepository(ctx: DynamoRepositoryContext): AlertRepository {
  async function withLinks(item: StoredItem, op: string): Promise<PersistedAlert> {
    return itemToAlert(item, await alertLinks(ctx, item.alertId, op));
  }

  /** Full replace: unlink every child, then Put the whole item (crash-safe order, §5.4). */
  async function insert(alert: UrbaniIncidentAlert, source: DataSource = 'MOCK', status: AlertStatus = 'OPEN'): Promise<void> {
    const item = alertItem(alert, source, status, ctx.now());
    await unlinkAll(ctx, alert.alertId);
    await send(ctx, new PutCommand({ TableName: ctx.tableName, Item: item }), 'alerts.insert');
  }

  /**
   * One UpdateItem whose SET list comes from items.alertItem(alert, 'LIVE', 'OPEN'), minus the keys and the
   * lifecycle attributes, plus `#status = if_not_exists(#status, :open)`. The acknowledgement is never
   * touched, so a re-sync cannot revert it.
   */
  async function upsertLivePreservingStatus(alert: UrbaniIncidentAlert): Promise<void> {
    const item = alertItem(alert, 'LIVE', 'OPEN', ctx.now());
    await unlinkAll(ctx, alert.alertId);
    const sets: string[] = [];
    const names: Record<string, string> = { '#status': 'status' };
    const values: Record<string, unknown> = { ':open': 'OPEN' };
    for (const [attr, value] of Object.entries(item)) {
      if (LIVE_UPSERT_SKIPPED.has(attr) || value === undefined) continue;
      sets.push(`#${attr} = :${attr}`);
      names[`#${attr}`] = attr;
      values[`:${attr}`] = value;
    }
    sets.push('#status = if_not_exists(#status, :open)');
    await send(
      ctx,
      new UpdateCommand({
        TableName: ctx.tableName,
        Key: alertKey(alert.alertId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
      'alerts.upsertLivePreservingStatus',
    );
  }

  async function findById(alertId: string): Promise<PersistedAlert | null> {
    if (!fitsKey(ALERT_PK, alertId)) return null;
    const res = await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: alertKey(alertId), ConsistentRead: true }),
      'alerts.findById',
    );
    return res.Item ? withLinks(res.Item, 'alerts.findById') : null;
  }

  /** The whole partition, filtered, sorted and paged in memory like the SQL; links only for the page. */
  async function query(filter: AlertFilter): Promise<PageResult<PersistedAlert>> {
    const all = await queryAll<StoredItem>(ctx, partitionQuery(ALERT_PK), 'alerts.query');
    const like = filter.search ? compileLike(filter.search) : null;
    const matches = all.filter(
      (a) =>
        (!filter.service || a.service === filter.service) &&
        (!filter.environment || a.environment === filter.environment) &&
        (!filter.severity || a.severity === filter.severity) &&
        (!filter.anomalyType || a.anomalyType === filter.anomalyType) &&
        (!filter.status || a.status === filter.status) &&
        (!filter.dataSource || a.dataSource === filter.dataSource) &&
        (!filter.from || compareBinary(a.timestamp, filter.from) >= 0) &&
        (!filter.to || compareBinary(a.timestamp, filter.to) <= 0) &&
        (!like || like(a.summary) || like(a.anomalyType) || like(a.probableCause)),
    );
    matches.sort((x, y) => compareBinary(y.timestamp, x.timestamp) || compareBinary(y.alertId, x.alertId));
    const { offset, pageSize } = clampPage(filter.page, filter.pageSize, 25);
    const page = matches.slice(offset, offset + pageSize);
    return { items: await mapLimit(page, 8, (a) => withLinks(a, 'alerts.query')), total: matches.length };
  }

  /** On a missing alert: [] is a no-op, any line raises REFERENCE_NOT_FOUND (§2.5-8). */
  async function replaceDerivedEvidence(alertId: string, lines: string[]): Promise<void> {
    const missing = (): void => {
      if (lines.length > 0) throw new PersistenceError('REFERENCE_NOT_FOUND', 'Referenced record not found');
    };
    if (!fitsKey(ALERT_PK, alertId)) return missing();
    try {
      await send(
        ctx,
        new UpdateCommand({
          TableName: ctx.tableName,
          Key: alertKey(alertId),
          UpdateExpression: 'SET #evidence = :ev',
          ConditionExpression: 'attribute_exists(#pk)',
          ExpressionAttributeNames: { '#evidence': 'evidence', '#pk': 'PK' },
          ExpressionAttributeValues: { ':ev': budgetEvidence(lines, alertId) },
        }),
        'alerts.replaceDerivedEvidence',
        { handled: [CONDITIONAL_CHECK_FAILED] },
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return missing();
      throw err;
    }
  }

  /**
   * Per selected alert: unlink, then a DeleteItem conditioned on the data source. An alert that flipped
   * source meanwhile is not deleted and not counted. BatchWriteItem cannot carry that condition.
   */
  async function deleteByDataSource(source: DataSource): Promise<number> {
    const op = 'alerts.deleteByDataSource';
    const selected = await queryAll<{ alertId: string }>(
      ctx,
      {
        IndexName: APP_TABLE_GSI1,
        KeyConditionExpression: '#gsi1pk = :src',
        ProjectionExpression: '#alertId',
        ExpressionAttributeNames: { '#gsi1pk': 'GSI1PK', '#alertId': 'alertId' },
        ExpressionAttributeValues: { ':src': alertSourcePk(source) },
      },
      op,
    );
    const deleted = await mapLimit(selected, 8, async ({ alertId }): Promise<number> => {
      await unlinkAll(ctx, alertId);
      try {
        await send(
          ctx,
          new DeleteCommand({
            TableName: ctx.tableName,
            Key: alertKey(alertId),
            ConditionExpression: '#dataSource = :src',
            ExpressionAttributeNames: { '#dataSource': 'dataSource' },
            ExpressionAttributeValues: { ':src': source },
          }),
          op,
          { handled: [CONDITIONAL_CHECK_FAILED] },
        );
        return 1;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return 0;
        throw err;
      }
    });
    return deleted.reduce((n, d) => n + d, 0);
  }

  /** OPEN → ACKNOWLEDGED once; on a condition failure the current alert (or null) is returned. */
  async function acknowledge(alertId: string, actor: string): Promise<PersistedAlert | null> {
    if (!fitsKey(ALERT_PK, alertId)) return null;
    try {
      const res = await send(
        ctx,
        new UpdateCommand({
          TableName: ctx.tableName,
          Key: alertKey(alertId),
          UpdateExpression: 'SET #status = :ack, #acknowledgedBy = :actor, #acknowledgedAt = :now',
          ConditionExpression: 'attribute_exists(#pk) AND #status = :open',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#acknowledgedBy': 'acknowledgedBy',
            '#acknowledgedAt': 'acknowledgedAt',
            '#pk': 'PK',
          },
          ExpressionAttributeValues: { ':ack': 'ACKNOWLEDGED', ':actor': actor, ':now': ctx.now(), ':open': 'OPEN' },
          ReturnValues: 'ALL_NEW',
        }),
        'alerts.acknowledge',
        { handled: [CONDITIONAL_CHECK_FAILED] },
      );
      // ReturnValues ALL_NEW always carries the updated item on success.
      return withLinks(res.Attributes as StoredItem, 'alerts.acknowledge');
    } catch (err) {
      if (isConditionalCheckFailed(err)) return findById(alertId);
      throw err;
    }
  }

  async function countAll(): Promise<number> {
    return queryCount(ctx, partitionQuery(ALERT_PK), 'alerts.countAll');
  }

  async function countActive(): Promise<number> {
    return queryCount(
      ctx,
      partitionQuery(ALERT_PK, { filter: ACTIVE_FILTER, names: { '#status': 'status' }, values: ACTIVE_VALUES }),
      'alerts.countActive',
    );
  }

  async function countBySeverity(severity: string): Promise<number> {
    return queryCount(
      ctx,
      partitionQuery(ALERT_PK, {
        filter: `#severity = :severity AND ${ACTIVE_FILTER}`,
        names: { '#severity': 'severity', '#status': 'status' },
        values: { ':severity': severity, ...ACTIVE_VALUES },
      }),
      'alerts.countBySeverity',
    );
  }

  return {
    insert,
    upsertLivePreservingStatus,
    findById,
    query,
    replaceDerivedEvidence,
    deleteByDataSource,
    acknowledge,
    countAll,
    countActive,
    countBySeverity,
  };
}
