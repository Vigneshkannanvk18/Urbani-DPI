import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';
import type { UrbaniIncidentAlert, DataSource } from '@urbani/shared';

/**
 * AI analyses repository (Epic 8). Stores each analysis run (provider-agnostic).
 * The full finding is kept as JSON so the exact UrbaniIncidentAlert contract is
 * preserved regardless of which provider produced it.
 */

export interface AIAnalysisRecord {
  id: string;
  alertId: string | null;
  timestamp: string;
  service: string;
  environment: string;
  modelId: string;
  provider: string;
  anomalyType: string | null;
  confidence: number | null;
  finding: UrbaniIncidentAlert | null;
  inputTokens: number;
  outputTokens: number;
  dataSource: DataSource;
}

function db(): Database.Database {
  return getDb();
}

export const aiRepository = {
  insert(rec: Omit<AIAnalysisRecord, 'id'> & { id?: string }): string {
    const id = rec.id ?? randomUUID();
    db()
      .prepare(
        `INSERT INTO ai_analyses
         (id, alert_id, timestamp, service, environment, model_id, provider, anomaly_type,
          confidence, finding_json, input_tokens, output_tokens, data_source, created_at)
         VALUES (@id, @alert_id, @timestamp, @service, @environment, @model_id, @provider,
                 @anomaly_type, @confidence, @finding_json, @input_tokens, @output_tokens,
                 @data_source, @created_at)`,
      )
      .run({
        id,
        alert_id: rec.alertId,
        timestamp: rec.timestamp,
        service: rec.service,
        environment: rec.environment,
        model_id: rec.modelId,
        provider: rec.provider,
        anomaly_type: rec.anomalyType,
        confidence: rec.confidence,
        finding_json: JSON.stringify(rec.finding),
        input_tokens: rec.inputTokens,
        output_tokens: rec.outputTokens,
        data_source: rec.dataSource,
        created_at: new Date().toISOString(),
      });
    return id;
  },

  query(opts: { page?: number; pageSize?: number }): { items: AIAnalysisRecord[]; total: number } {
    const total = (db().prepare('SELECT COUNT(*) AS c FROM ai_analyses').get() as { c: number }).c;
    const page = Math.max(opts.page ?? 1, 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 200);
    const rows = db()
      .prepare('SELECT * FROM ai_analyses ORDER BY timestamp DESC LIMIT ? OFFSET ?')
      .all(pageSize, (page - 1) * pageSize) as any[];
    return { items: rows.map(mapRow), total };
  },

  findById(id: string): AIAnalysisRecord | null {
    const row = db().prepare('SELECT * FROM ai_analyses WHERE id = ?').get(id) as any;
    return row ? mapRow(row) : null;
  },

  count(): number {
    return (db().prepare('SELECT COUNT(*) AS c FROM ai_analyses').get() as { c: number }).c;
  },
};

function mapRow(r: any): AIAnalysisRecord {
  return {
    id: r.id,
    alertId: r.alert_id,
    timestamp: r.timestamp,
    service: r.service,
    environment: r.environment,
    modelId: r.model_id,
    provider: r.provider,
    anomalyType: r.anomaly_type,
    confidence: r.confidence,
    finding: r.finding_json ? (JSON.parse(r.finding_json) as UrbaniIncidentAlert) : null,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    dataSource: r.data_source as DataSource,
  };
}
