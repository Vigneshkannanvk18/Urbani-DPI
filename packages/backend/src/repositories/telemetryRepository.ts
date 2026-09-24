import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';
import type {
  ServiceSummary,
  LogEntry,
  MetricSnapshot,
  UsageRecord,
  LogLevel,
  ServiceStatus,
} from '@urbani/shared';

/**
 * Telemetry repository (Data Layer) for services, logs, metrics and usage.
 * Backs the read-side of the dashboard. All rows carry a data_source column so
 * provenance can be surfaced to the UI.
 */

function db(): Database.Database {
  return getDb();
}

export const serviceRepository = {
  all(): ServiceSummary[] {
    const rows = db().prepare('SELECT * FROM services ORDER BY name').all() as any[];
    return rows.map(mapService);
  },
  findById(id: string): ServiceSummary | null {
    const row = db().prepare('SELECT * FROM services WHERE id = ?').get(id) as any;
    return row ? mapService(row) : null;
  },
  count(): number {
    return (db().prepare('SELECT COUNT(*) AS c FROM services').get() as { c: number }).c;
  },
};

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

export interface LogFilter {
  service?: string;
  environment?: string;
  level?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export const logRepository = {
  query(filter: LogFilter): { items: LogEntry[]; total: number } {
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
  },
  byAlert(alertId: string): LogEntry[] {
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
  },
};

export const metricRepository = {
  query(filter: { service?: string; environment?: string; limit?: number }): MetricSnapshot[] {
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
  },
};

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

export const usageRepository = {
  all(): UsageRecord[] {
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
  },
};
