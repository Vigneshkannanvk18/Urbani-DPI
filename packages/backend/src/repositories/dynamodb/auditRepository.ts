import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { AuditAction, AuditEvent, AuditResult } from '@urbani/shared';
import { PersistenceError } from '../../lib/errors';
import { clampPage, decodeCursor, encodeCursor } from '../common';
import { auditCursorSchema, parseAuditRangeQuery, parseAuditResult } from '../validation';
import type { AuditEventRecord, AuditQuery, AuditRangeQuery, AuditRepository, CursorPage, PageResult } from '../types';
import type { DynamoRepositoryContext } from './index';
import { auditItem, itemToAuditEvent, itemToAuditRecord, type StoredItem } from './items';
import { AUDIT_PK, auditActorPk, auditSortKey, fitsPartitionKey } from './keys';
import {
  CONDITIONAL_CHECK_FAILED,
  isConditionalCheckFailed,
  partitionQuery,
  queryAll,
  queryUpTo,
  send,
  type QueryInput,
} from './ops';
import { APP_TABLE_GSI1 } from './tableDefinition';

/**
 * Audit events, DynamoDB driver (design §5.3 patterns 10–13). Items live in the `AUDIT` partition with
 * SK `<timestamp>#<id>` and GSI1 `ACTOR#<actor>`, so key order is time order (timestamps are toISOString()).
 */
export function dynamoAuditRepository(ctx: DynamoRepositoryContext): AuditRepository {
  /** Create-only Put; an id collision regenerates the id once, a second one raises DUPLICATE. */
  async function record(
    actor: string,
    action: AuditAction,
    target?: string,
    metadata?: Record<string, unknown>,
    result?: AuditResult,
  ): Promise<void> {
    const outcome = parseAuditResult(result);
    const now = ctx.now();
    for (let attempt = 1; ; attempt++) {
      const item = auditItem({
        id: randomUUID(),
        timestamp: now,
        actor,
        action,
        target: target ?? null,
        // Never persist secrets/PII in metadata — callers pass safe fields only.
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        result: outcome,
        createdAt: now,
      });
      try {
        await send(
          ctx,
          new PutCommand({
            TableName: ctx.tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'PK' },
          }),
          'audit.record',
          { handled: [CONDITIONAL_CHECK_FAILED] },
        );
        return;
      } catch (err) {
        if (!isConditionalCheckFailed(err)) throw err;
        if (attempt >= 2) throw new PersistenceError('DUPLICATE', 'Record already exists');
      }
    }
  }

  /** Legacy list: newest first, action filtered and paged in memory. Items have no `result` key. */
  async function query(opts: AuditQuery): Promise<PageResult<AuditEvent>> {
    let items: StoredItem[];
    if (opts.actor) {
      if (!fitsPartitionKey(auditActorPk(opts.actor))) return { items: [], total: 0 };
      items = await queryAll<StoredItem>(
        ctx,
        {
          IndexName: APP_TABLE_GSI1,
          KeyConditionExpression: '#gsi1pk = :actor',
          ExpressionAttributeNames: { '#gsi1pk': 'GSI1PK' },
          ExpressionAttributeValues: { ':actor': auditActorPk(opts.actor) },
          ScanIndexForward: false,
        },
        'audit.query',
      );
    } else {
      items = await queryAll<StoredItem>(ctx, partitionQuery(AUDIT_PK, { descending: true }), 'audit.query');
    }
    const matches = opts.action ? items.filter((e) => e.action === opts.action) : items;
    const { offset, pageSize } = clampPage(opts.page, opts.pageSize, 50);
    return { items: matches.slice(offset, offset + pageSize).map(itemToAuditEvent), total: matches.length };
  }

  /**
   * Newest first with inclusive bounds: `from` maps to `>= from`, `to` to `<= to + '$'` ('$' sorts right
   * after the '#' delimiter). The cursor is validated against the bounds before any query.
   */
  async function listByTimeRange(opts: AuditRangeQuery): Promise<CursorPage<AuditEventRecord>> {
    const q = parseAuditRangeQuery(opts);
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor, auditCursorSchema(q.from, q.to));
    const byActor = q.actor !== null;
    const names: Record<string, string> = { '#pk': byActor ? 'GSI1PK' : 'PK' };
    const values: Record<string, unknown> = { ':pk': byActor ? auditActorPk(q.actor as string) : AUDIT_PK };
    let condition = '#pk = :pk';
    if (q.from !== null || q.to !== null) {
      names['#sk'] = byActor ? 'GSI1SK' : 'SK';
      if (q.from !== null) values[':from'] = q.from;
      if (q.to !== null) values[':toHi'] = `${q.to}$`;
      condition +=
        q.from !== null && q.to !== null
          ? ' AND #sk BETWEEN :from AND :toHi'
          : q.from !== null
            ? ' AND #sk >= :from'
            : ' AND #sk <= :toHi';
    }
    const input: QueryInput = {
      KeyConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
      ...(byActor ? { IndexName: APP_TABLE_GSI1 } : { ConsistentRead: true }),
    };
    if (after) {
      const sk = auditSortKey(after[0], after[1]);
      input.ExclusiveStartKey = byActor
        ? { PK: AUDIT_PK, SK: sk, GSI1PK: auditActorPk(q.actor as string), GSI1SK: sk }
        : { PK: AUDIT_PK, SK: sk };
    }
    const items = await queryUpTo<StoredItem>(ctx, input, q.limit + 1, 'audit.listByTimeRange');
    // The extra item only decides whether another page exists.
    const more = items.length > q.limit;
    const page = more ? items.slice(0, q.limit) : items;
    const last = page[page.length - 1];
    return {
      items: page.map(itemToAuditRecord),
      nextCursor: more && last ? encodeCursor([last.timestamp, last.id]) : null,
    };
  }

  return { record, query, listByTimeRange };
}
