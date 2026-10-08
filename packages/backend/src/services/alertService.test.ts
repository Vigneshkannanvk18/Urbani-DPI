import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { UrbaniIncidentAlert } from '@urbani/shared';
import type { LogEntry } from '@urbani/shared';
import { freshTestDb } from '../test/testDb';
import { alertRepository } from '../repositories/alertRepository';
import { alertService, matchEvidence } from './alertService';
import { NotFoundError } from '../lib/errors';

const sampleAlert: UrbaniIncidentAlert = {
  alertId: 'ALT-TEST-001',
  timestamp: '2026-09-23T08:00:00.000Z',
  service: 'main',
  environment: 'qa',
  severity: 'CRITICAL',
  anomalyType: 'DatabaseConnectionTimeout',
  summary: 'DB connection timeouts',
  evidence: ['2026-09-23 08:00:00 ERROR ConnectionPool: Timeout'],
  probableCause: 'Pool exhaustion',
  recommendedActions: ['Check RDS connections', 'Review recent deploys'],
  confidence: 0.92,
  modelId: 'global.amazon.nova-2-lite-v1:0',
};

describe('alertService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshTestDb();
    alertRepository.insert(sampleAlert, 'MOCK', 'OPEN');
  });

  afterEach(() => db.close());

  it('lists alerts with a MOCK provenance label and pagination envelope', async () => {
    const res = await alertService.list({ pageSize: 10 });
    expect(res.source).toBe('MOCK');
    expect(res.data.total).toBe(1);
    expect(res.data.items[0].alertId).toBe('ALT-TEST-001');
  });

  it('filters by severity', async () => {
    expect((await alertService.list({ severity: 'CRITICAL' })).data.total).toBe(1);
    expect((await alertService.list({ severity: 'LOW' })).data.total).toBe(0);
  });

  it('returns evidence and recommended actions on detail', async () => {
    const res = await alertService.get('ALT-TEST-001', 'tester@urbani.local');
    expect(res.data.evidence).toHaveLength(1);
    expect(res.data.recommendedActions).toHaveLength(2);
  });

  it('throws NotFound for a missing alert', async () => {
    await expect(alertService.get('nope', 'tester@urbani.local')).rejects.toThrow(NotFoundError);
  });

  it('acknowledges an OPEN alert (human-in-the-loop, no remediation)', async () => {
    const res = await alertService.acknowledge('ALT-TEST-001', 'engineer@urbani.local');
    expect(res.data.status).toBe('ACKNOWLEDGED');
    expect(res.data.acknowledgedBy).toBe('engineer@urbani.local');
    // Acknowledgement is the only lifecycle action — verify no auto-resolution.
    expect(res.data.status).not.toBe('RESOLVED');
  });

  it('a live re-sync does NOT revert an acknowledged alert to OPEN (AC7, repository level)', () => {
    // Driven at the repository layer: syncLiveAlerts() is config-gated and would
    // early-return in mock-mode tests, so prove the invariant on the primitive
    // the live sync actually uses (upsertLivePreservingStatus).
    const liveAlert: UrbaniIncidentAlert = {
      ...sampleAlert,
      alertId: 'ALT-LIVE-RESYNC',
      confidence: null, // live QA alerts carry no confidence
    };
    alertRepository.upsertLivePreservingStatus(liveAlert); // new row -> OPEN
    expect(alertRepository.findById('ALT-LIVE-RESYNC')!.status).toBe('OPEN');

    alertRepository.acknowledge('ALT-LIVE-RESYNC', 'ops@urbani.local');
    // Re-sync the SAME alert (as a periodic poll would).
    alertRepository.upsertLivePreservingStatus({ ...liveAlert, summary: 'refreshed body' });

    const after = alertRepository.findById('ALT-LIVE-RESYNC')!;
    expect(after.status).toBe('ACKNOWLEDGED');
    expect(after.acknowledgedBy).toBe('ops@urbani.local');
    expect(after.acknowledgedAt).toBeTruthy();
    // The body is still refreshed to the latest upstream version.
    expect(after.summary).toBe('refreshed body');
    // Nullable confidence passes through.
    expect(after.confidence).toBeNull();
  });
});

describe('matchEvidence (live alert ↔ log correlation heuristic)', () => {
  const alert: UrbaniIncidentAlert = {
    ...sampleAlert,
    service: 'main',
    timestamp: '2026-10-05T10:00:00.000Z',
    anomalyType: 'DatabaseConnectionTimeout',
    summary: 'HTTP_403 forbidden on /orders; database connection slowdown',
  };

  function log(partial: Partial<LogEntry>): LogEntry {
    return {
      id: partial.id ?? 'log-x',
      timestamp: partial.timestamp ?? '2026-10-05T10:01:00.000Z',
      level: partial.level ?? 'ERROR',
      service: partial.service ?? 'main',
      environment: 'qa',
      message: partial.message ?? '',
    };
  }

  it('matches same-service lines in the window on an HTTP status token', () => {
    const logs = [
      log({ id: 'a', message: 'GET /orders returned 403 Forbidden' }),
      log({ id: 'b', message: 'all healthy 200 OK', service: 'main' }),
    ];
    const matched = matchEvidence(alert, logs);
    expect(matched.map((l) => l.id)).toEqual(['a']);
  });

  it('matches on an anomaly keyword (database/connection/timeout)', () => {
    const logs = [log({ id: 'c', message: 'ERROR database connection timeout acquiring pool' })];
    expect(matchEvidence(alert, logs).map((l) => l.id)).toEqual(['c']);
  });

  it('rejects a different service', () => {
    const logs = [log({ id: 'd', service: 'payments', message: 'database connection timeout' })];
    expect(matchEvidence(alert, logs)).toEqual([]);
  });

  it('rejects a line far outside the timestamp window', () => {
    const logs = [log({ id: 'e', timestamp: '2026-10-05T14:00:00.000Z', message: '403 forbidden' })];
    expect(matchEvidence(alert, logs)).toEqual([]);
  });

  it('returns [] (never fabricates) when nothing matches', () => {
    const logs = [log({ id: 'f', message: 'nothing relevant here' })];
    expect(matchEvidence(alert, logs)).toEqual([]);
  });

  it('caps at 10 matched lines, newest-first', () => {
    const logs: LogEntry[] = Array.from({ length: 15 }, (_, i) =>
      log({
        id: `m${i}`,
        // Stagger timestamps within the window; i=0 oldest, i=14 newest.
        timestamp: new Date(Date.parse('2026-10-05T10:00:00.000Z') + i * 1000).toISOString(),
        message: 'database connection timeout',
      }),
    );
    const matched = matchEvidence(alert, logs);
    expect(matched).toHaveLength(10);
    // Newest first.
    expect(matched[0].id).toBe('m14');
  });
});
