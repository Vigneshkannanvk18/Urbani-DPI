import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';
import type { PersistedAlert, UrbaniIncidentAlert, AlertStatus, DataSource } from '@urbani/shared';

/**
 * Alert repository (Data Layer).
 *
 * Maps between the snake_case SQLite rows and the camelCase domain contract.
 * This is the swap point for Phase 2: the same method surface can be backed by
 * a real DynamoDB table without changing the service layer.
 */

export interface AlertFilter {
  service?: string;
  environment?: string;
  severity?: string;
  anomalyType?: string;
  status?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

interface AlertRow {
  alert_id: string;
  timestamp: string;
  service: string;
  environment: string;
  severity: string;
  anomaly_type: string;
  summary: string;
  probable_cause: string;
  confidence: number | null;
  model_id: string;
  status: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  data_source: string;
}

function db(): Database.Database {
  return getDb();
}

function loadChildren(alertId: string): { evidence: string[]; actions: string[] } {
  const evidence = db()
    .prepare('SELECT line FROM alert_evidence WHERE alert_id = ? ORDER BY ordinal')
    .all(alertId)
    .map((r) => (r as { line: string }).line);
  const actions = db()
    .prepare('SELECT action FROM alert_recommended_actions WHERE alert_id = ? ORDER BY ordinal')
    .all(alertId)
    .map((r) => (r as { action: string }).action);
  return { evidence, actions };
}

function rowToAlert(row: AlertRow): PersistedAlert {
  const { evidence, actions } = loadChildren(row.alert_id);
  const relatedLogIds = db()
    .prepare('SELECT id FROM log_references WHERE alert_id = ?')
    .all(row.alert_id)
    .map((r) => (r as { id: string }).id);
  const relatedMetricIds = db()
    .prepare('SELECT id FROM metric_snapshots WHERE alert_id = ?')
    .all(row.alert_id)
    .map((r) => (r as { id: string }).id);

  return {
    alertId: row.alert_id,
    timestamp: row.timestamp,
    service: row.service,
    environment: row.environment,
    severity: row.severity as PersistedAlert['severity'],
    anomalyType: row.anomaly_type,
    summary: row.summary,
    evidence,
    probableCause: row.probable_cause,
    recommendedActions: actions,
    confidence: row.confidence,
    modelId: row.model_id,
    status: row.status as AlertStatus,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at,
    relatedLogIds,
    relatedMetricIds,
  };
}

export const alertRepository = {
  insert(alert: UrbaniIncidentAlert, source: DataSource = 'MOCK', status: AlertStatus = 'OPEN'): void {
    const tx = db().transaction(() => {
      db()
        .prepare(
          `INSERT OR REPLACE INTO alerts
           (alert_id, timestamp, service, environment, severity, anomaly_type, summary,
            probable_cause, confidence, model_id, status, data_source, created_at)
           VALUES (@alert_id, @timestamp, @service, @environment, @severity, @anomaly_type,
                   @summary, @probable_cause, @confidence, @model_id, @status, @data_source, @created_at)`,
        )
        .run({
          alert_id: alert.alertId,
          timestamp: alert.timestamp,
          service: alert.service,
          environment: alert.environment,
          severity: alert.severity,
          anomaly_type: alert.anomalyType,
          summary: alert.summary,
          probable_cause: alert.probableCause,
          confidence: alert.confidence,
          model_id: alert.modelId,
          status,
          data_source: source,
          created_at: new Date().toISOString(),
        });

      db().prepare('DELETE FROM alert_evidence WHERE alert_id = ?').run(alert.alertId);
      const evStmt = db().prepare(
        'INSERT INTO alert_evidence (id, alert_id, ordinal, line) VALUES (?, ?, ?, ?)',
      );
      alert.evidence.forEach((line, i) => evStmt.run(randomUUID(), alert.alertId, i, line));

      db().prepare('DELETE FROM alert_recommended_actions WHERE alert_id = ?').run(alert.alertId);
      const acStmt = db().prepare(
        'INSERT INTO alert_recommended_actions (id, alert_id, ordinal, action) VALUES (?, ?, ?, ?)',
      );
      alert.recommendedActions.forEach((a, i) => acStmt.run(randomUUID(), alert.alertId, i, a));
    });
    tx();
  },

  /**
   * Upsert a LIVE alert WITHOUT clobbering its lifecycle. If the row already
   * exists, its current status / acknowledged_by / acknowledged_at are preserved
   * so a periodic re-sync of the same alert does NOT un-acknowledge it. New rows
   * default to 'OPEN'. The alert body (summary/evidence/actions/etc.) is always
   * refreshed to the latest upstream version.
   */
  upsertLivePreservingStatus(alert: UrbaniIncidentAlert): void {
    const existing = db()
      .prepare(
        'SELECT status, acknowledged_by, acknowledged_at FROM alerts WHERE alert_id = ?',
      )
      .get(alert.alertId) as
      | { status: string; acknowledged_by: string | null; acknowledged_at: string | null }
      | undefined;

    const status = (existing?.status as AlertStatus) ?? 'OPEN';
    const acknowledgedBy = existing?.acknowledged_by ?? null;
    const acknowledgedAt = existing?.acknowledged_at ?? null;

    const tx = db().transaction(() => {
      db()
        .prepare(
          `INSERT OR REPLACE INTO alerts
           (alert_id, timestamp, service, environment, severity, anomaly_type, summary,
            probable_cause, confidence, model_id, status, acknowledged_by, acknowledged_at,
            data_source, created_at)
           VALUES (@alert_id, @timestamp, @service, @environment, @severity, @anomaly_type,
                   @summary, @probable_cause, @confidence, @model_id, @status, @acknowledged_by,
                   @acknowledged_at, @data_source, @created_at)`,
        )
        .run({
          alert_id: alert.alertId,
          timestamp: alert.timestamp,
          service: alert.service,
          environment: alert.environment,
          severity: alert.severity,
          anomaly_type: alert.anomalyType,
          summary: alert.summary,
          probable_cause: alert.probableCause,
          confidence: alert.confidence,
          model_id: alert.modelId,
          status,
          acknowledged_by: acknowledgedBy,
          acknowledged_at: acknowledgedAt,
          data_source: 'LIVE',
          created_at: new Date().toISOString(),
        });

      db().prepare('DELETE FROM alert_evidence WHERE alert_id = ?').run(alert.alertId);
      const evStmt = db().prepare(
        'INSERT INTO alert_evidence (id, alert_id, ordinal, line) VALUES (?, ?, ?, ?)',
      );
      alert.evidence.forEach((line, i) => evStmt.run(randomUUID(), alert.alertId, i, line));

      db().prepare('DELETE FROM alert_recommended_actions WHERE alert_id = ?').run(alert.alertId);
      const acStmt = db().prepare(
        'INSERT INTO alert_recommended_actions (id, alert_id, ordinal, action) VALUES (?, ?, ?, ?)',
      );
      alert.recommendedActions.forEach((a, i) => acStmt.run(randomUUID(), alert.alertId, i, a));
    });
    tx();
  },

  findById(alertId: string): PersistedAlert | null {
    const row = db().prepare('SELECT * FROM alerts WHERE alert_id = ?').get(alertId) as
      | AlertRow
      | undefined;
    return row ? rowToAlert(row) : null;
  },

  query(filter: AlertFilter): { items: PersistedAlert[]; total: number } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.service) (where.push('service = @service'), (params.service = filter.service));
    if (filter.environment)
      (where.push('environment = @environment'), (params.environment = filter.environment));
    if (filter.severity) (where.push('severity = @severity'), (params.severity = filter.severity));
    if (filter.anomalyType)
      (where.push('anomaly_type = @anomalyType'), (params.anomalyType = filter.anomalyType));
    if (filter.status) (where.push('status = @status'), (params.status = filter.status));
    if (filter.from) (where.push('timestamp >= @from'), (params.from = filter.from));
    if (filter.to) (where.push('timestamp <= @to'), (params.to = filter.to));
    if (filter.search) {
      where.push('(summary LIKE @search OR anomaly_type LIKE @search OR probable_cause LIKE @search)');
      params.search = `%${filter.search}%`;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      db().prepare(`SELECT COUNT(*) AS c FROM alerts ${whereSql}`).get(params) as { c: number }
    ).c;

    const page = Math.max(filter.page ?? 1, 1);
    const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 200);
    const rows = db()
      .prepare(
        `SELECT * FROM alerts ${whereSql} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as AlertRow[];

    return { items: rows.map(rowToAlert), total };
  },

  acknowledge(alertId: string, actor: string): PersistedAlert | null {
    const res = db()
      .prepare(
        `UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ?
         WHERE alert_id = ? AND status = 'OPEN'`,
      )
      .run(actor, new Date().toISOString(), alertId);
    if (res.changes === 0 && !this.findById(alertId)) return null;
    return this.findById(alertId);
  },

  countActive(): number {
    return (
      db()
        .prepare("SELECT COUNT(*) AS c FROM alerts WHERE status IN ('OPEN','ACKNOWLEDGED')")
        .get() as { c: number }
    ).c;
  },

  countBySeverity(severity: string): number {
    return (
      db()
        .prepare(
          "SELECT COUNT(*) AS c FROM alerts WHERE severity = ? AND status IN ('OPEN','ACKNOWLEDGED')",
        )
        .get(severity) as { c: number }
    ).c;
  },
};
