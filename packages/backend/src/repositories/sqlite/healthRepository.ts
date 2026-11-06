import { getDb } from '../../db/connection';
import type { HealthCheckResult, HealthRepository } from '../types';
import { healthBucket, parseHealthRange, parseHealthResult, parseReadId } from '../validation';
import type { SqliteContext } from './index';

/**
 * Readiness probe (GET /ready) and service health results (DPI 2 item 9), SQLite driver.
 * Results are keyed by (target_id, minute bucket) so a repeated write in the same minute is idempotent.
 */
interface HealthRow {
  target_id: string;
  timestamp: string;
  status: HealthCheckResult['status'];
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
}

const toResult = (r: HealthRow): HealthCheckResult => ({
  targetId: r.target_id,
  timestamp: r.timestamp,
  status: r.status,
  httpStatus: r.http_status,
  latencyMs: r.latency_ms,
  error: r.error,
});

export function sqliteHealthRepository(_ctx: SqliteContext): HealthRepository {
  async function ping(): Promise<void> {
    getDb().prepare('SELECT 1').get();
  }

  async function recordResult(input: HealthCheckResult): Promise<void> {
    const r = parseHealthResult(input);
    getDb()
      .prepare(
        `INSERT INTO health_results (target_id, bucket, timestamp, status, http_status, latency_ms, error)
         VALUES (@targetId, @bucket, @timestamp, @status, @httpStatus, @latencyMs, @error)
         ON CONFLICT(target_id, bucket) DO UPDATE SET
           timestamp = excluded.timestamp, status = excluded.status, http_status = excluded.http_status,
           latency_ms = excluded.latency_ms, error = excluded.error`,
      )
      .run({ ...r, bucket: healthBucket(r.timestamp) });
  }

  async function listResults(targetId: string, from: string, to: string, limit?: number): Promise<HealthCheckResult[]> {
    const q = parseHealthRange(targetId, from, to, limit);
    const rows = getDb()
      .prepare(
        `SELECT * FROM health_results WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(q.targetId, q.from, q.to, q.limit) as HealthRow[];
    return rows.map(toResult);
  }

  async function latestResult(targetId: string): Promise<HealthCheckResult | null> {
    const id = parseReadId(targetId);
    const row = getDb()
      .prepare('SELECT * FROM health_results WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1')
      .get(id) as HealthRow | undefined;
    return row ? toResult(row) : null;
  }

  async function purgeOlderThan(cutoff: string): Promise<number> {
    return getDb().prepare('DELETE FROM health_results WHERE bucket < ?').run(healthBucket(cutoff)).changes;
  }

  return { ping, recordResult, listResults, latestResult, purgeOlderThan };
}
