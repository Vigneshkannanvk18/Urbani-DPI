import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { UrbaniIncidentAlert } from '@urbani/shared';
import { freshTestDb } from '../test/testDb';
import { getDb } from '../db/connection';
import { alertRepository } from './alertRepository';
import { logRepository } from './telemetryRepository';

/**
 * Tests for the alert↔log correlation primitives added for Fix 1 / Fix 5:
 *  - alertRepository.replaceDerivedEvidence (idempotent, caps implicitly via caller)
 *  - alertRepository.deleteByDataSource (removes MOCK, keeps LIVE, cascades children)
 *  - logRepository.clearAlertLinks + linkLogsToAlert (set/clear log_references.alert_id)
 */

const baseAlert: UrbaniIncidentAlert = {
  alertId: 'ALT-CORR-001',
  timestamp: '2026-10-05T10:00:00.000Z',
  service: 'main',
  environment: 'qa',
  severity: 'HIGH',
  anomalyType: 'DatabaseConnectionTimeout',
  summary: 'DB connection pool exhausted',
  evidence: [],
  probableCause: 'Unclosed sessions',
  recommendedActions: ['Check pool size'],
  confidence: 0.8,
  modelId: 'global.amazon.nova-2-lite-v1:0',
};

/** Seed a log_references row directly (seeded logs are the only persisted ones). */
function seedLog(id: string, service: string, message: string): void {
  getDb()
    .prepare(
      `INSERT INTO log_references (id, timestamp, level, service, environment, message, data_source)
       VALUES (?, ?, ?, ?, ?, ?, 'MOCK')`,
    )
    .run(id, '2026-10-05T10:01:00.000Z', 'ERROR', service, 'qa', message);
}

function evidenceLines(alertId: string): string[] {
  return getDb()
    .prepare('SELECT line FROM alert_evidence WHERE alert_id = ? ORDER BY ordinal')
    .all(alertId)
    .map((r) => (r as { line: string }).line);
}

describe('alert correlation primitives', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshTestDb();
  });

  afterEach(() => db.close());

  it('replaceDerivedEvidence writes, replaces (idempotent) and clears', () => {
    alertRepository.upsertLivePreservingStatus(baseAlert);

    alertRepository.replaceDerivedEvidence(baseAlert.alertId, ['line a', 'line b']);
    expect(evidenceLines(baseAlert.alertId)).toEqual(['line a', 'line b']);

    // Re-running with new lines REPLACES (no duplicates, idempotent across syncs).
    alertRepository.replaceDerivedEvidence(baseAlert.alertId, ['line c']);
    expect(evidenceLines(baseAlert.alertId)).toEqual(['line c']);

    // An empty array clears evidence (never fabricates lines).
    alertRepository.replaceDerivedEvidence(baseAlert.alertId, []);
    expect(evidenceLines(baseAlert.alertId)).toEqual([]);
  });

  it('deleteByDataSource removes MOCK rows, keeps LIVE rows, cascades children', () => {
    // One seeded MOCK alert (with evidence) + one LIVE alert.
    alertRepository.insert(
      { ...baseAlert, alertId: 'ALT-MOCK-1', evidence: ['mock evidence'] },
      'MOCK',
      'OPEN',
    );
    alertRepository.upsertLivePreservingStatus({ ...baseAlert, alertId: 'ALT-LIVE-1' });

    const removed = alertRepository.deleteByDataSource('MOCK');
    expect(removed).toBe(1);

    expect(alertRepository.findById('ALT-MOCK-1')).toBeNull();
    expect(alertRepository.findById('ALT-LIVE-1')).not.toBeNull();

    // Child evidence rows for the deleted MOCK alert cascade away.
    expect(evidenceLines('ALT-MOCK-1')).toEqual([]);
  });

  it('deleteByDataSource nulls log_references.alert_id for deleted alerts (ON DELETE SET NULL)', () => {
    alertRepository.insert({ ...baseAlert, alertId: 'ALT-MOCK-2' }, 'MOCK', 'OPEN');
    seedLog('log-x', 'main', 'ERROR DatabaseConnectionTimeout');
    logRepository.linkLogsToAlert('ALT-MOCK-2', ['log-x']);
    expect(logRepository.byAlert('ALT-MOCK-2')).toHaveLength(1);

    alertRepository.deleteByDataSource('MOCK');
    expect(logRepository.byAlert('ALT-MOCK-2')).toHaveLength(0);
  });

  it('linkLogsToAlert + clearAlertLinks set and clear related-logs links', () => {
    alertRepository.upsertLivePreservingStatus(baseAlert);
    seedLog('log-1', 'main', 'ERROR pool timeout');
    seedLog('log-2', 'main', 'INFO healthy');

    logRepository.linkLogsToAlert(baseAlert.alertId, ['log-1']);
    expect(logRepository.byAlert(baseAlert.alertId).map((l) => l.id)).toEqual(['log-1']);

    // Clear then re-link to a different id (idempotent sync behaviour).
    logRepository.clearAlertLinks(baseAlert.alertId);
    expect(logRepository.byAlert(baseAlert.alertId)).toHaveLength(0);

    logRepository.linkLogsToAlert(baseAlert.alertId, ['log-2']);
    expect(logRepository.byAlert(baseAlert.alertId).map((l) => l.id)).toEqual(['log-2']);
  });

  it('linkLogsToAlert is a no-op for ids absent from log_references (LIVE lines)', () => {
    alertRepository.upsertLivePreservingStatus(baseAlert);
    // Simulate a LIVE adapter id that was never persisted — must not error.
    logRepository.linkLogsToAlert(baseAlert.alertId, [`main:123:${randomUUID()}`]);
    expect(logRepository.byAlert(baseAlert.alertId)).toHaveLength(0);
  });
});
