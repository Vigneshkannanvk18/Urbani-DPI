import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';
import type { AuditEvent, AuditAction } from '@urbani/shared';

/** Audit repository (Epic 11). Precursor to CloudTrail integration. */

interface AuditRow {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  metadata: string | null;
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

export const auditRepository = {
  record(actor: string, action: AuditAction, target?: string, metadata?: Record<string, unknown>): void {
    const now = new Date().toISOString();
    db()
      .prepare(
        `INSERT INTO audit_events (id, timestamp, actor, action, target, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      // Never persist secrets/PII in metadata — callers pass safe fields only.
      .run(randomUUID(), now, actor, action, target ?? null, metadata ? JSON.stringify(metadata) : null, now);
  },

  query(opts: { action?: string; actor?: string; page?: number; pageSize?: number }): {
    items: AuditEvent[];
    total: number;
  } {
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
  },
};
