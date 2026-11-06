import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../../db/connection';
import type { AuditEvent, AuditAction, AuditResult } from '@urbani/shared';
import { decodeCursor, encodeCursor } from '../common';
import { auditCursorSchema, parseAuditRangeQuery, parseAuditResult } from '../validation';
import type {
  AuditEventRecord,
  AuditQuery,
  AuditRangeQuery,
  AuditRepository,
  CursorPage,
} from '../types';
import type { SqliteContext } from './index';
import { buildAuditMetadata } from '../../lib/auditMetadata';

/** Redacted metadata plus request context, serialized (null when empty). */
function storedMetadata(metadata?: Record<string, unknown>): string | null {
  const m = buildAuditMetadata(metadata);
  return m ? JSON.stringify(m) : null;
}

/** Audit repository (Epic 11), SQLite driver. Precursor to CloudTrail integration. */

interface AuditRow {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  metadata: string | null;
  result: string;
}

function db(): Database.Database {
  return getDb();
}

function rowTo(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action as AuditAction,
    target: row.target,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  };
}

export function sqliteAuditRepository(ctx: SqliteContext): AuditRepository {
  /** result defaults to SUCCESS and is validated before the write. */
  async function record(
    actor: string,
    action: AuditAction,
    target?: string,
    metadata?: Record<string, unknown>,
    result?: AuditResult,
  ): Promise<void> {
    const outcome = parseAuditResult(result);
    const now = ctx.now();
    db()
      .prepare(
        `INSERT INTO audit_events (id, timestamp, actor, action, target, metadata, created_at, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // Never persist secrets/PII in metadata — callers pass safe fields only.
      .run(randomUUID(), now, actor, action, target ?? null, storedMetadata(metadata), now, outcome);
  }

  async function query(opts: AuditQuery): Promise<{
    items: AuditEvent[];
    total: number;
  }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.action) (where.push('action = @action'), (params.action = opts.action));
    if (opts.actor) (where.push('actor = @actor'), (params.actor = opts.actor));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      db().prepare(`SELECT COUNT(*) AS c FROM audit_events ${whereSql}`).get(params) as { c: number }
    ).c;
    const page = Math.max(opts.page ?? 1, 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
    const rows = db()
      .prepare(`SELECT * FROM audit_events ${whereSql} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as AuditRow[];
    return { items: rows.map(rowTo), total };
  }

  /** Newest first, inclusive bounds, optional actor; keyset pages over (timestamp, id). */
  async function listByTimeRange(opts: AuditRangeQuery): Promise<CursorPage<AuditEventRecord>> {
    const q = parseAuditRangeQuery(opts);
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor, auditCursorSchema(q.from, q.to));
    const actionParams: Record<string, string> = {};
    const actionList = (q.actions ?? []).map((a, i) => {
      actionParams[`a${i}`] = a;
      return `@a${i}`;
    });
    const actionSql = q.actions ? (actionList.length ? `AND action IN (${actionList.join(',')})` : 'AND 0') : '';
    const rows = db()
      .prepare(
        `SELECT * FROM audit_events
          WHERE (@from IS NULL OR timestamp >= @from)
            AND (@to IS NULL OR timestamp <= @to)
            AND (@actor IS NULL OR actor = @actor)
            AND (@result IS NULL OR result = @result)
            AND (@text IS NULL OR instr(lower(coalesce(target, '') || ' ' || coalesce(metadata, '')), @text) > 0)
            AND (@mc IS NULL OR instr(coalesce(metadata, ''), @mc) > 0)
            ${actionSql}
            ${after ? 'AND (timestamp < @cts OR (timestamp = @cts AND id < @cid))' : ''}
          ORDER BY timestamp DESC, id DESC
          LIMIT @limit + 1`,
      )
      .all({
        from: q.from,
        to: q.to,
        actor: q.actor,
        result: q.result,
        text: q.text,
        mc: q.metadataContains,
        ...actionParams,
        limit: q.limit,
        ...(after ? { cts: after[0], cid: after[1] } : {}),
      }) as AuditRow[];
    // The extra row only decides whether another page exists.
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ ...rowTo(r), result: r.result as AuditResult })),
      nextCursor: more && last ? encodeCursor([last.timestamp, last.id]) : null,
    };
  }

  async function purgeOlderThan(cutoff: string): Promise<number> {
    return db().prepare('DELETE FROM audit_events WHERE timestamp < ?').run(cutoff).changes;
  }
  return { record, query, listByTimeRange, purgeOlderThan };
}
