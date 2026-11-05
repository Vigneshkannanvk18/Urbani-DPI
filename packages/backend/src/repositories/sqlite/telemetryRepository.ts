import type Database from 'better-sqlite3';
import { getDb } from '../../db/connection';
import type {
  ServiceSummary,
  LogEntry,
  MetricSnapshot,
  UsageRecord,
  LogLevel,
  ServiceStatus,
  DataSource,
} from '@urbani/shared';
import type {
  EnvironmentRecord,
  EnvironmentRepository,
  LogFilter,
  LogRepository,
  MetricFilter,
  MetricRepository,
  ServiceInput,
  ServiceRepository,
  UsageRepository,
} from '../types';
import type { SqliteContext } from './index';

/**
 * Telemetry repositories (Data Layer), SQLite driver: services, environments, logs,
 * metrics and usage. Backs the read-side of the dashboard. All rows carry a
 * data_source column so provenance can be surfaced to the UI.
 */

function db(): Database.Database {
  return getDb();
}

export function sqliteServiceRepository(ctx: SqliteContext): ServiceRepository {
  async function all(): Promise<ServiceSummary[]> {
    const rows = db().prepare('SELECT * FROM services ORDER BY name').all() as any[];
    return rows.map(mapService);
  }
  async function findById(id: string): Promise<ServiceSummary | null> {
    const row = db().prepare('SELECT * FROM services WHERE id = ?').get(id) as any;
    return row ? mapService(row) : null;
  }
  async function count(): Promise<number> {
    return (db().prepare('SELECT COUNT(*) AS c FROM services').get() as { c: number }).c;
  }
  /** Seed write: INSERT OR REPLACE. */
  async function upsert(service: ServiceInput, source: DataSource): Promise<void> {
    db()
      .prepare(
        `INSERT OR REPLACE INTO services
         (id, name, environment, status, error_rate, last_telemetry_at, last_incident_at, data_source, created_at)
         VALUES (@id, @name, @environment, @status, @error_rate, @last_telemetry_at, @last_incident_at, @data_source, @created_at)`,
      )
      .run({
        id: service.id,
        name: service.name,
        environment: service.environment,
        status: service.status,
        error_rate: service.errorRate,
        last_telemetry_at: service.lastTelemetryAt,
        last_incident_at: service.lastIncidentAt,
        data_source: source,
        created_at: ctx.now(),
      });
  }
  return { all, findById, count, upsert };
}

function mapService(row: any): ServiceSummary {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    status: row.status as ServiceStatus,
    errorRate: row.error_rate,
    lastTelemetryAt: row.last_telemetry_at,
    lastIncidentAt: row.last_incident_at,
    alertCount: (
      db().prepare('SELECT COUNT(*) AS c FROM alerts WHERE service = ?').get(row.name) as {
        c: number;
      }
    ).c,
  };
}

export function sqliteEnvironmentRepository(ctx: SqliteContext): EnvironmentRepository {
  /** Seed write: INSERT OR IGNORE, so an existing environment is never overwritten. */
  async function ensure(env: { id: string; name: string }): Promise<void> {
    db()
      .prepare('INSERT OR IGNORE INTO environments (id, name, created_at) VALUES (?, ?, ?)')
      .run(env.id, env.name, ctx.now());
  }
  async function all(): Promise<EnvironmentRecord[]> {
    const rows = db()
      .prepare('SELECT id, name, created_at FROM environments ORDER BY name')
      .all() as { id: string; name: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }
  return { ensure, all };
}

export function sqliteLogRepository(_ctx: SqliteContext): LogRepository {
  async function query(filter: LogFilter): Promise<{ items: LogEntry[]; total: number }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.service) (where.push('service = @service'), (params.service = filter.service));
    if (filter.environment)
      (where.push('environment = @environment'), (params.environment = filter.environment));
    if (filter.level) (where.push('level = @level'), (params.level = filter.level));
    if (filter.search) (where.push('message LIKE @search'), (params.search = `%${filter.search}%`));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      db().prepare(`SELECT COUNT(*) AS c FROM log_references ${whereSql}`).get(params) as {
        c: number;
      }
    ).c;
    const page = Math.max(filter.page ?? 1, 1);
    const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 200);
    const rows = db()
      .prepare(
        `SELECT * FROM log_references ${whereSql} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as any[];
    return {
      items: rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        level: r.level as LogLevel,
        service: r.service,
        environment: r.environment,
        message: r.message,
      })),
      total,
    };
  }
  async function byAlert(alertId: string): Promise<LogEntry[]> {
    const rows = db()
      .prepare('SELECT * FROM log_references WHERE alert_id = ? ORDER BY timestamp DESC')
      .all(alertId) as any[];
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      level: r.level as LogLevel,
      service: r.service,
      environment: r.environment,
      message: r.message,
    }));
  }

  /**
   * Clear every related-logs link for an alert (set alert_id = NULL). Used before
   * re-linking during a live correlation pass so repeated syncs stay idempotent.
   */
  async function clearAlertLinks(alertId: string): Promise<void> {
    db().prepare('UPDATE log_references SET alert_id = NULL WHERE alert_id = ?').run(alertId);
  }

  /**
   * Stamp log_references.alert_id for the given log ids so byAlert(alertId)
   * returns them as related logs. Only ids that already exist in log_references
   * are affected — LIVE adapter logs are NOT persisted here, so this is a no-op
   * for them; alert_evidence (message strings) carries the matched LIVE lines.
   */
  async function linkLogsToAlert(alertId: string, logIds: string[]): Promise<void> {
    if (logIds.length === 0) return;
    const stmt = db().prepare('UPDATE log_references SET alert_id = ? WHERE id = ?');
    const tx = db().transaction(() => {
      for (const id of logIds) stmt.run(alertId, id);
    });
    tx();
  }

  /** Seed write: INSERT OR REPLACE in one transaction; alert_id is omitted, so a link resets to NULL. */
  async function upsertMany(logs: LogEntry[], source: DataSource): Promise<void> {
    const stmt = db().prepare(
      `INSERT OR REPLACE INTO log_references
       (id, timestamp, level, service, environment, message, data_source)
       VALUES (@id, @timestamp, @level, @service, @environment, @message, @data_source)`,
    );
    const tx = db().transaction(() => {
      for (const l of logs) {
        stmt.run({
          id: l.id,
          timestamp: l.timestamp,
          level: l.level,
          service: l.service,
          environment: l.environment,
          message: l.message,
          data_source: source,
        });
      }
    });
    tx();
  }

  return { query, byAlert, clearAlertLinks, linkLogsToAlert, upsertMany };
}

export function sqliteMetricRepository(_ctx: SqliteContext): MetricRepository {
  async function query(filter: MetricFilter): Promise<MetricSnapshot[]> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.service) (where.push('service = @service'), (params.service = filter.service));
    if (filter.environment)
      (where.push('environment = @environment'), (params.environment = filter.environment));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(filter.limit ?? 200, 500);
    const rows = db()
      .prepare(`SELECT * FROM metric_snapshots ${whereSql} ORDER BY timestamp DESC LIMIT @limit`)
      .all({ ...params, limit }) as any[];
    return rows.map(mapMetric);
  }

  /** Seed write: INSERT OR REPLACE in one transaction, with alert_id NULL. */
  async function upsertMany(metrics: MetricSnapshot[], source: DataSource): Promise<void> {
    const stmt = db().prepare(
      `INSERT OR REPLACE INTO metric_snapshots
       (id, service, environment, timestamp, cpu_percent, memory_percent, error_rate,
        request_count, latency_ms_p95, http_5xx_count, instance_restarts, data_source)
       VALUES (@id, @service, @environment, @timestamp, @cpu_percent, @memory_percent, @error_rate,
               @request_count, @latency_ms_p95, @http_5xx_count, @instance_restarts, @data_source)`,
    );
    const tx = db().transaction(() => {
      for (const m of metrics) {
        stmt.run({
          id: m.id,
          service: m.service,
          environment: m.environment,
          timestamp: m.timestamp,
          cpu_percent: m.cpuPercent,
          memory_percent: m.memoryPercent,
          error_rate: m.errorRate,
          request_count: m.requestCount,
          latency_ms_p95: m.latencyMsP95,
          http_5xx_count: m.http5xxCount,
          instance_restarts: m.instanceRestarts,
          data_source: source,
        });
      }
    });
    tx();
  }

  return { query, upsertMany };
}

function mapMetric(r: any): MetricSnapshot {
  return {
    id: r.id,
    service: r.service,
    environment: r.environment,
    timestamp: r.timestamp,
    cpuPercent: r.cpu_percent,
    memoryPercent: r.memory_percent,
    errorRate: r.error_rate,
    requestCount: r.request_count,
    latencyMsP95: r.latency_ms_p95,
    http5xxCount: r.http_5xx_count,
    instanceRestarts: r.instance_restarts,
  };
}

export function sqliteUsageRepository(_ctx: SqliteContext): UsageRepository {
  async function all(): Promise<UsageRecord[]> {
    const rows = db().prepare('SELECT * FROM usage_records ORDER BY date DESC').all() as any[];
    return rows.map((r) => ({
      id: r.id,
      date: r.date,
      modelId: r.model_id,
      aiRequestCount: r.ai_request_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      estimatedCostUsd: r.estimated_cost_usd,
    }));
  }

  /** Seed write: INSERT OR REPLACE in one transaction. */
  async function upsertMany(records: UsageRecord[], source: DataSource): Promise<void> {
    const stmt = db().prepare(
      `INSERT OR REPLACE INTO usage_records
       (id, date, model_id, ai_request_count, input_tokens, output_tokens, estimated_cost_usd, data_source)
       VALUES (@id, @date, @model_id, @ai_request_count, @input_tokens, @output_tokens, @estimated_cost_usd, @data_source)`,
    );
    const tx = db().transaction(() => {
      for (const u of records) {
        stmt.run({
          id: u.id,
          date: u.date,
          model_id: u.modelId,
          ai_request_count: u.aiRequestCount,
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          estimated_cost_usd: u.estimatedCostUsd,
          data_source: source,
        });
      }
    });
    tx();
  }

  return { all, upsertMany };
}
