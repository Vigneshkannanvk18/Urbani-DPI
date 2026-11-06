import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UrbaniIncidentAlert } from '@urbani/shared';
import { createSqliteRepositories } from '../repositories/sqlite';
import type { Repositories } from '../repositories/types';
import { ENTITY_TYPES } from '../repositories/dynamodb/keys';
import { dynamoHarness, makeTestClock } from '../test/repositoryHarness';
import { freshTestDb } from '../test/testDb';
import { MIGRATION_ENTITIES, migrateSqliteToDynamo, readSqliteSnapshot, type SqliteSnapshot } from './migrateSqliteToDynamo';

/**
 * SQLite → DynamoDB migration (design §8.3, §10). readSqliteSnapshot runs in the default suite on in-memory
 * databases. The opt-in block writes through harness.context() into this file's own test table and reads
 * back through the DynamoDB repositories that harness.fresh() builds for that table.
 */

const T0_MS = Date.parse('2026-09-01T00:00:00.000Z');
const at = (sec: number): string => new Date(T0_MS + sec * 1000).toISOString();
const sorted = (values: string[]): string[] => [...values].sort();

function makeAlert(alertId: string, over: Partial<UrbaniIncidentAlert> = {}): UrbaniIncidentAlert {
  return {
    alertId,
    timestamp: at(10),
    service: 'main',
    environment: 'qa',
    severity: 'HIGH',
    anomalyType: 'DatabaseConnectionTimeout',
    summary: 'DB connection pool exhausted',
    evidence: ['evidence line 1'],
    probableCause: 'Unclosed sessions',
    recommendedActions: ['Check pool size'],
    confidence: 0.8,
    modelId: 'model-test',
    ...over,
  };
}

function databaseWith001Only(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations', '001_initial_schema.sql'), 'utf8'));
  return db;
}

describe('readSqliteSnapshot on a 001-only database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = databaseWith001Only();
    db.prepare('INSERT INTO roles (id, name, description, permissions, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'role-admin', 'ADMIN', null, '["*"]', at(0));
    db.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role_id, is_active, last_login_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, ?)`,
    ).run('user-1', 'admin@example.test', 'Admin', 'hash-not-a-secret', 'role-admin', at(0));
    const audit = db.prepare(
      'INSERT INTO audit_events (id, timestamp, actor, action, target, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    audit.run('audit-1', at(1), 'admin@example.test', 'CONFIG_CHANGED', 'chat', '{"outcome":"unavailable"}', at(1));
    audit.run('audit-2', at(2), 'admin@example.test', 'CONFIG_CHANGED', 'chat', '{"outcome":"answered"}', at(2));
    audit.run('audit-3', at(3), 'admin@example.test', 'LOGIN', null, null, at(3));
    audit.run('audit-4', at(4), 'admin@example.test', 'LOGIN', null, 'not json', at(4));
    db.prepare(
      `INSERT INTO alerts (alert_id, timestamp, service, environment, severity, anomaly_type, summary, probable_cause,
         confidence, model_id, status, data_source, created_at)
       VALUES ('ALT-1', ?, 'main', 'qa', 'HIGH', 'Timeout', 'summary', 'cause', NULL, 'model-test', 'OPEN', 'MOCK', ?)`,
    ).run(at(10), at(10));
    // Inserted out of order: the snapshot must follow the ordinals.
    const evidence = db.prepare('INSERT INTO alert_evidence (id, alert_id, ordinal, line) VALUES (?, ?, ?, ?)');
    evidence.run('ev-b', 'ALT-1', 1, 'second');
    evidence.run('ev-a', 'ALT-1', 0, 'first');
    const action = db.prepare('INSERT INTO alert_recommended_actions (id, alert_id, ordinal, action) VALUES (?, ?, ?, ?)');
    action.run('ac-b', 'ALT-1', 1, 'then this');
    action.run('ac-a', 'ALT-1', 0, 'do this');
    db.prepare(
      `INSERT INTO log_references (id, timestamp, level, service, environment, message, alert_id, data_source)
       VALUES ('log-1', ?, 'ERROR', 'main', 'qa', 'boom', 'ALT-1', 'MOCK')`,
    ).run(at(11));
    db.prepare(
      `INSERT INTO metric_snapshots (id, service, environment, timestamp, alert_id, data_source)
       VALUES ('metric-1', 'main', 'qa', ?, 'ALT-1', 'MOCK')`,
    ).run(at(12));
    db.prepare(
      `INSERT INTO ai_analyses (id, alert_id, timestamp, service, environment, model_id, provider, finding_json, created_at)
       VALUES ('ana-1', 'ALT-1', ?, 'main', 'qa', 'model-test', 'MockAIProvider', 'null', ?)`,
    ).run(at(13), at(13));
  });

  afterEach(() => db.close());

  it('defaults the role, backfills results with the 002 rule and counts the new tables as empty', () => {
    const snap = readSqliteSnapshot(db);
    expect(snap.users).toHaveLength(1);
    expect(snap.users[0].role).toBe('SUPER_ADMIN');
    expect(snap.users[0].created_at).toBe(at(0));
    expect(snap.audit.map((r) => [r.id, r.result])).toEqual([
      ['audit-1', 'FAILURE'],
      ['audit-2', 'SUCCESS'],
      ['audit-3', 'SUCCESS'],
      ['audit-4', 'SUCCESS'],
    ]);
    expect(snap.preferences).toEqual([]);
    expect(snap.chatSessions).toEqual([]);
    expect(snap.chatMessages).toEqual([]);
    expect(snap.chatFeedback).toEqual([]);
    expect(Object.keys(snap).sort()).toEqual([...MIGRATION_ENTITIES].sort());
  });

  it('reads evidence and actions in ordinal order and keeps the alert links', () => {
    const snap = readSqliteSnapshot(db);
    expect(snap.alerts[0].evidence).toEqual(['first', 'second']);
    expect(snap.alerts[0].recommendedActions).toEqual(['do this', 'then this']);
    expect(snap.logs[0].alert_id).toBe('ALT-1');
    expect(snap.metrics[0].alert_id).toBe('ALT-1');
    expect(snap.aiAnalyses[0].alert_id).toBe('ALT-1');
  });
});

describe('readSqliteSnapshot on a 002 database', () => {
  let db: ReturnType<typeof freshTestDb>;

  beforeEach(() => {
    db = freshTestDb();
  });

  afterEach(() => db.close());

  it('reads the stored role and result and the new tables', async () => {
    const repos = createSqliteRepositories({ now: makeTestClock() });
    await repos.users.upsertRole({ id: 'role-admin', name: 'ADMIN', description: null, permissions: '["*"]', created_at: at(0) });
    await repos.users.upsertUser({
      id: 'user-1',
      email: 'ops@example.test',
      display_name: 'Ops',
      password_hash: 'hash-not-a-secret',
      role_id: 'role-admin',
      is_active: 1,
      last_login_at: null,
      created_at: at(0),
      role: 'QA_OPERATOR',
    });
    await repos.audit.record('ops@example.test', 'CONFIG_CHANGED', 'settings', undefined, 'DENIED');
    await repos.preferences.update('user-1', { theme: 'light', widgetLayout: { widgets: ['alerts'] } });
    const session = await repos.chat.createSession({ userId: 'user-1', title: 'Chat' });
    const message = await repos.chat.appendMessage({ sessionId: session.id, role: 'user', content: 'hi', citations: ['log-1'] });
    await repos.chat.setFeedback({ sessionId: session.id, messageId: message.id, userId: 'user-1', rating: 'DISLIKE' });

    const snap = readSqliteSnapshot(db);
    expect(snap.users[0].role).toBe('QA_OPERATOR');
    expect(snap.audit[0].result).toBe('DENIED');
    expect(snap.preferences).toEqual([
      expect.objectContaining({ user_id: 'user-1', theme: 'light', widget_layout_json: '{"widgets":["alerts"]}' }),
    ]);
    expect(snap.chatSessions).toEqual([expect.objectContaining({ id: session.id, message_count: 1 })]);
    expect(snap.chatMessages).toEqual([expect.objectContaining({ id: message.id, citations_json: '["log-1"]' })]);
    expect(snap.chatFeedback).toEqual([expect.objectContaining({ message_id: message.id, rating: 'DISLIKE' })]);
  });
});

const endpoint = process.env.DYNAMODB_ENDPOINT;

describe.skipIf(!endpoint)('migrateSqliteToDynamo on DynamoDB Local (set DYNAMODB_ENDPOINT to run)', { timeout: 20_000 }, () => {
  const harness = dynamoHarness(endpoint!);
  let snapshot: SqliteSnapshot;
  let repos: Repositories;
  /** What the SQLite repositories return for the source. */
  let expected: Record<string, unknown>;
  let messageIds: string[];

  /** Builds the source through the SQLite repositories; a metric link needs raw SQL (no repository sets it). */
  async function buildSource(db: Database.Database, sqlite: Repositories): Promise<void> {
    await sqlite.users.upsertRole({ id: 'role-admin', name: 'ADMIN', description: 'Full access', permissions: '["*"]', created_at: at(0) });
    await sqlite.users.upsertRole({ id: 'role-viewer', name: 'VIEWER', description: null, permissions: '["read"]', created_at: at(0) });
    const user = {
      display_name: 'Ops',
      password_hash: 'hash-not-a-secret',
      role_id: 'role-admin',
      is_active: 1,
      last_login_at: null,
      created_at: at(0),
    };
    await sqlite.users.upsertUser({ ...user, id: 'user-1', email: 'ops@example.test', role: 'QA_OPERATOR' });
    await sqlite.users.upsertUser({ ...user, id: 'user-2', email: 'viewer@example.test', role_id: 'role-viewer', is_active: 0 });
    await sqlite.preferences.update('user-1', { theme: 'dark', widgetLayout: { widgets: ['alerts', 'logs'] } });
    await sqlite.environments.ensure({ id: 'env-qa', name: 'qa' });
    await sqlite.services.upsert(
      { id: 'svc-main', name: 'main', environment: 'qa', status: 'DEGRADED', errorRate: 0.2, lastTelemetryAt: at(5), lastIncidentAt: at(6) },
      'MOCK',
    );
    await sqlite.alerts.insert(
      makeAlert('ALT-1', { evidence: ['first', 'second', 'third'], recommendedActions: ['zeta', 'alpha'] }),
      'LIVE',
      'OPEN',
    );
    await sqlite.alerts.insert(makeAlert('ALT-2', { timestamp: at(20), confidence: null }), 'MOCK', 'OPEN');
    await sqlite.alerts.acknowledge('ALT-2', 'ops@example.test');
    await sqlite.logs.upsertMany(
      ['log-1', 'log-2', 'log-3'].map((id, i) => ({
        id,
        timestamp: at(30 + i),
        level: 'ERROR' as const,
        service: 'main',
        environment: 'qa',
        message: `message ${id}`,
      })),
      'MOCK',
    );
    await sqlite.logs.linkLogsToAlert('ALT-1', ['log-1', 'log-2']);
    await sqlite.metrics.upsertMany(
      ['metric-1', 'metric-2'].map((id, i) => ({
        id,
        service: 'main',
        environment: 'qa',
        timestamp: at(40 + i),
        cpuPercent: 41.5,
        memoryPercent: 63.25,
        errorRate: 0.02,
        requestCount: 1200,
        latencyMsP95: 310,
        http5xxCount: 3,
        instanceRestarts: 0,
      })),
      'MOCK',
    );
    db.prepare('UPDATE metric_snapshots SET alert_id = ? WHERE id = ?').run('ALT-1', 'metric-1');
    await sqlite.aiAnalyses.insert({
      id: 'ana-1',
      alertId: 'ALT-1',
      timestamp: at(50),
      service: 'main',
      environment: 'qa',
      modelId: 'model-test',
      provider: 'MockAIProvider',
      anomalyType: 'DatabaseConnectionTimeout',
      confidence: 0.7,
      finding: makeAlert('ALT-1'),
      inputTokens: 10,
      outputTokens: 20,
      dataSource: 'MOCK',
    });
    await sqlite.usage.upsertMany(
      [{ id: 'usage-1', date: '2026-09-01', modelId: 'model-test', aiRequestCount: 2, inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.01 }],
      'MOCK',
    );
    await sqlite.audit.record('ops@example.test', 'LOGIN');
    await sqlite.audit.record('ops@example.test', 'CONFIG_CHANGED', 'settings', { field: 'theme' }, 'DENIED');
    await sqlite.integrations.upsert({
      id: 'int-cloudwatch',
      kind: 'CLOUDWATCH',
      display_name: 'CloudWatch',
      mode: 'MOCK',
      status: 'WAITING_FOR_INTEGRATION',
      config_json: '{}',
      updated_at: at(0),
    });
    await sqlite.chat.createSession({ id: 'session-1', userId: 'user-1', title: 'Pool exhaustion', service: 'main', environment: 'qa' });
    const question = await sqlite.chat.appendMessage({ sessionId: 'session-1', role: 'user', content: 'Why is the pool exhausted?' });
    const answer = await sqlite.chat.appendMessage({
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Sessions are not closed.',
      citations: ['log-1'],
      provider: 'MockAIProvider',
      modelId: 'model-test',
      source: 'MOCK',
      latencyMs: 12,
      inputTokens: 3,
      outputTokens: 4,
    });
    messageIds = [question.id, answer.id];
    await sqlite.chat.setFeedback({ sessionId: 'session-1', messageId: answer.id, userId: 'user-1', rating: 'LIKE', comment: 'helpful' });
  }

  const migrate = (dryRun: boolean) =>
    migrateSqliteToDynamo({ snapshot, ctx: harness.context(), dryRun, sourcePath: ':memory:', endpoint: endpoint ?? null });

  beforeAll(async () => {
    await harness.setupSuite();
    const db = freshTestDb();
    try {
      const sqlite = createSqliteRepositories({ now: makeTestClock('2026-09-02T00:00:00.000Z') });
      await buildSource(db, sqlite);
      snapshot = readSqliteSnapshot(db);
      expected = {
        alert1: await sqlite.alerts.findById('ALT-1'),
        alert2: await sqlite.alerts.findById('ALT-2'),
        analysis: await sqlite.aiAnalyses.findById('ana-1'),
        logsByAlert: await sqlite.logs.byAlert('ALT-1'),
        prefs: await sqlite.preferences.get('user-1'),
        session: await sqlite.chat.getSession('session-1'),
        sessions: await sqlite.chat.listSessionsByUser('user-1'),
        messages: await sqlite.chat.listMessages('session-1'),
        feedback: await sqlite.chat.listFeedback('session-1'),
        audit: await sqlite.audit.listByTimeRange({}),
      };
    } finally {
      db.close();
    }
  }, 60_000);
  beforeEach(async () => {
    repos = await harness.fresh(makeTestClock());
  });
  afterEach(() => harness.cleanup());
  afterAll(() => harness.teardownSuite(), 60_000);

  it('a dry run reports the would-create counts and writes nothing', async () => {
    const report = await migrate(true);
    expect(report.dryRun).toBe(true);
    for (const entity of MIGRATION_ENTITIES) {
      expect(report.entities[entity]).toEqual({
        source: snapshot[entity].length,
        created: snapshot[entity].length,
        skipped: 0,
        failed: 0,
        trimmedEvidence: 0,
      });
    }
    expect(report.totals.source).toBe(23);
    expect(await harness.scanAll()).toEqual([]);
  });

  it('a real run creates every item, with evidence, links and the user email lock', async () => {
    const report = await migrate(false);
    for (const entity of MIGRATION_ENTITIES) {
      expect(report.entities[entity].created).toBe(snapshot[entity].length);
    }
    expect(report.totals).toEqual({ source: 23, created: 23, skipped: 0, failed: 0, trimmedEvidence: 0 });

    const alert = await repos.alerts.findById('ALT-1');
    expect(alert?.evidence).toEqual(['first', 'second', 'third']);
    expect(alert?.recommendedActions).toEqual(['zeta', 'alpha']);
    expect(sorted(alert?.relatedLogIds ?? [])).toEqual(['log-1', 'log-2']);
    expect(await repos.logs.byAlert('ALT-1')).toEqual(expected.logsByAlert);
    expect(await repos.alerts.findById('ALT-2')).toEqual(expected.alert2);
    expect(await repos.aiAnalyses.findById('ana-1')).toEqual(expected.analysis);
    expect((await repos.audit.listByTimeRange({})).items).toEqual((expected.audit as { items: unknown[] }).items);

    const items = await harness.scanAll();
    // One item per source row, plus one email lock per user.
    expect(items).toHaveLength(report.totals.created + snapshot.users.length);
    expect(items.find((i) => i.PK === 'USER_EMAIL' && i.SK === 'ops@example.test')).toEqual({
      PK: 'USER_EMAIL',
      SK: 'ops@example.test',
      entityType: 'USER_EMAIL',
      userId: 'user-1',
    });
    expect((await repos.users.findByEmail('ops@example.test'))?.role).toBe('QA_OPERATOR');
  });

  it('every migrated item carries an entityType', async () => {
    await migrate(false);
    const items = await harness.scanAll();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(ENTITY_TYPES).toContain(item.entityType);
  });

  it('preferences, chat sessions, messages and feedback read back equal to SQLite', async () => {
    await migrate(false);
    expect(await repos.preferences.get('user-1')).toEqual(expected.prefs);
    expect(await repos.chat.getSession('session-1')).toEqual(expected.session);
    expect(await repos.chat.listSessionsByUser('user-1')).toEqual(expected.sessions);
    expect(await repos.chat.listMessages('session-1')).toEqual(expected.messages);
    expect((await repos.chat.listMessages('session-1')).items.map((m) => m.id)).toEqual(messageIds);
    expect(await repos.chat.listFeedback('session-1')).toEqual(expected.feedback);
  });

  it('a re-run creates nothing and skips everything', async () => {
    await migrate(false);
    const again = await migrate(false);
    for (const entity of MIGRATION_ENTITIES) {
      expect(again.entities[entity]).toEqual({
        source: snapshot[entity].length,
        created: 0,
        skipped: snapshot[entity].length,
        failed: 0,
        trimmedEvidence: 0,
      });
    }
    const dry = await migrate(true);
    expect(dry.totals).toEqual({ source: 23, created: 0, skipped: 23, failed: 0, trimmedEvidence: 0 });
  });

  it('relatedMetricIds survive the migration', async () => {
    await migrate(false);
    const alert = await repos.alerts.findById('ALT-1');
    expect(alert?.relatedMetricIds).toEqual(['metric-1']);
    const want = expected.alert1 as NonNullable<Awaited<ReturnType<Repositories['alerts']['findById']>>>;
    expect({ ...alert, relatedLogIds: sorted(alert?.relatedLogIds ?? []) }).toEqual({
      ...want,
      relatedLogIds: sorted(want.relatedLogIds),
    });
  });
});
