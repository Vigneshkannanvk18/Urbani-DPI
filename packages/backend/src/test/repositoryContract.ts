import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { USER_ROLES } from '@urbani/shared';
import type {
  AuditAction,
  AuditResult,
  ChatMessageRole,
  LogEntry,
  MetricSnapshot,
  Theme,
  UrbaniIncidentAlert,
  UsageRecord,
  UserRole,
} from '@urbani/shared';
import { PersistenceError, type PersistenceReason } from '../lib/errors';
import { encodeCursor } from '../repositories/common';
import type {
  AuditEventRecord,
  ChatMessage,
  ChatSession,
  CursorPage,
  IntegrationRow,
  NewAIAnalysis,
  Repositories,
  RoleRow,
  ServiceInput,
  UserUpsert,
} from '../repositories/types';
import { makeTestClock, type RepositoryHarness } from './repositoryHarness';

/**
 * Repository contract suite (design §8.1, §8.2): 69 cases that every driver must pass. The cases use
 * only the Repositories interface. "Rejects" means rejects.toThrow() unless a PersistenceError reason
 * is named, because the drivers raise different error classes on legacy paths. Fixtures carry
 * distinct timestamps and relatedLogIds are compared sorted (SQLite returns them in rowid order).
 */

const BASE_MS = Date.parse('2026-10-05T00:00:00.000Z');
/** Fixture timestamp `sec` seconds after the base instant. */
const at = (sec: number): string => new Date(BASE_MS + sec * 1000).toISOString();
const pad = (i: number): string => String(i).padStart(3, '0');
const sorted = (values: string[]): string[] => [...values].sort();

function makeAlert(alertId: string, over: Partial<UrbaniIncidentAlert> = {}): UrbaniIncidentAlert {
  return {
    alertId,
    timestamp: at(0),
    service: 'main',
    environment: 'qa',
    severity: 'HIGH',
    anomalyType: 'DatabaseConnectionTimeout',
    summary: 'DB connection pool exhausted',
    evidence: ['evidence line 1', 'evidence line 2'],
    probableCause: 'Unclosed sessions',
    recommendedActions: ['Check pool size', 'Restart the worker'],
    confidence: 0.8,
    modelId: 'model-test',
    ...over,
  };
}

function makeLog(id: string, sec: number, over: Partial<LogEntry> = {}): LogEntry {
  return { id, timestamp: at(sec), level: 'ERROR', service: 'main', environment: 'qa', message: `log ${id}`, ...over };
}

function makeMetric(id: string, sec: number, over: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    id,
    service: 'main',
    environment: 'qa',
    timestamp: at(sec),
    cpuPercent: 41.5,
    memoryPercent: 63.25,
    errorRate: 0.02,
    requestCount: 1200,
    latencyMsP95: 310,
    http5xxCount: 3,
    instanceRestarts: 0,
    ...over,
  };
}

function makeAnalysis(over: Partial<NewAIAnalysis> = {}): NewAIAnalysis {
  return {
    alertId: null,
    timestamp: at(0),
    service: 'main',
    environment: 'qa',
    modelId: 'model-test',
    provider: 'MockAIProvider',
    anomalyType: 'DatabaseConnectionTimeout',
    confidence: 0.5,
    finding: null,
    inputTokens: 10,
    outputTokens: 20,
    dataSource: 'MOCK',
    ...over,
  };
}

function makeService(id: string, name: string, over: Partial<ServiceInput> = {}): ServiceInput {
  return {
    id,
    name,
    environment: 'qa',
    status: 'HEALTHY',
    errorRate: 0.01,
    lastTelemetryAt: at(5),
    lastIncidentAt: null,
    ...over,
  };
}

function makeIntegration(id: string, kind: string, over: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id,
    kind,
    display_name: `Integration ${id}`,
    mode: 'MOCK',
    status: 'WAITING_FOR_INTEGRATION',
    config_json: '{}',
    updated_at: at(0),
    ...over,
  };
}

const ADMIN_ROLE: RoleRow = {
  id: 'role-admin',
  name: 'ADMIN',
  description: 'Full access',
  permissions: JSON.stringify(['*']),
  created_at: at(0),
};

function makeUser(id: string, email: string, over: Partial<UserUpsert> = {}): UserUpsert {
  return {
    id,
    email,
    display_name: `User ${id}`,
    password_hash: 'hash-not-a-secret',
    role_id: ADMIN_ROLE.id,
    is_active: 1,
    last_login_at: null,
    created_at: at(0),
    ...over,
  };
}

async function expectReason(p: Promise<unknown>, reason: PersistenceReason): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PersistenceError);
  expect((err as PersistenceError).reason).toBe(reason);
}

function expectDescending(values: string[]): void {
  for (let i = 1; i < values.length; i++) expect(values[i - 1] > values[i]).toBe(true);
}

export function defineRepositoryContract(harness: RepositoryHarness): void {
  let repos: Repositories;
  /** Every value the repositories took from the test clock, in order. */
  let stamps: string[] = [];

  /** Runs fn and returns its value with the clock values issued while it ran. */
  async function withStamps<T>(fn: () => Promise<T>): Promise<{ value: T; stamps: string[] }> {
    const mark = stamps.length;
    const value = await fn();
    return { value, stamps: stamps.slice(mark) };
  }

  async function addUser(id: string, email: string, over: Partial<UserUpsert> = {}): Promise<UserUpsert> {
    await repos.users.upsertRole(ADMIN_ROLE);
    const user = makeUser(id, email, over);
    await repos.users.upsertUser(user);
    return user;
  }

  async function collectPages<T>(
    load: (cursor: string | undefined) => Promise<CursorPage<T>>,
  ): Promise<{ pages: T[][]; cursors: Array<string | null> }> {
    const pages: T[][] = [];
    const cursors: Array<string | null> = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await load(cursor);
      pages.push(page.items);
      cursors.push(page.nextCursor);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return { pages, cursors };
  }

  beforeAll(() => harness.setupSuite(), 60_000);
  beforeEach(async () => {
    const clock = makeTestClock();
    stamps = [];
    repos = await harness.fresh(() => {
      const value = clock();
      stamps.push(value);
      return value;
    });
  });
  afterEach(() => harness.cleanup());
  afterAll(() => harness.teardownSuite(), 60_000);

  // ---------------------------------------------------------------- Alerts

  it('C-AL-01 insert then findById returns every field', async () => {
    const a = makeAlert('ALT-1', {
      evidence: ['first line', 'second line', 'third line'],
      recommendedActions: ['zeta action', 'alpha action'],
    });
    await repos.alerts.insert(a);
    expect(await repos.alerts.findById('ALT-1')).toEqual({
      ...a,
      status: 'OPEN',
      acknowledgedBy: null,
      acknowledgedAt: null,
      relatedLogIds: [],
      relatedMetricIds: [],
    });

    const n = makeAlert('ALT-2', { timestamp: at(1), confidence: null });
    await repos.alerts.insert(n);
    const got = await repos.alerts.findById('ALT-2');
    expect(got?.confidence).toBeNull();
    expect(got).toEqual({
      ...n,
      status: 'OPEN',
      acknowledgedBy: null,
      acknowledgedAt: null,
      relatedLogIds: [],
      relatedMetricIds: [],
    });
  });

  it('C-AL-02 insert defaults to source MOCK and status OPEN', async () => {
    await repos.alerts.insert(makeAlert('ALT-1'));
    expect((await repos.alerts.findById('ALT-1'))?.status).toBe('OPEN');
    expect(await repos.alerts.deleteByDataSource('LIVE')).toBe(0);
    expect(await repos.alerts.findById('ALT-1')).not.toBeNull();
    expect(await repos.alerts.deleteByDataSource('MOCK')).toBe(1);
    expect(await repos.alerts.findById('ALT-1')).toBeNull();
  });

  it('C-AL-03 insert over an existing id replaces body, evidence and actions, sets status, clears ack', async () => {
    await repos.alerts.insert(makeAlert('ALT-1'));
    await repos.alerts.acknowledge('ALT-1', 'ops@urbani.test');
    const b = makeAlert('ALT-1', {
      timestamp: at(1),
      severity: 'LOW',
      summary: 'Replaced summary',
      evidence: ['replacement evidence'],
      recommendedActions: ['replacement action'],
      confidence: 0.3,
    });
    await repos.alerts.insert(b, 'MOCK', 'RESOLVED');
    expect(await repos.alerts.findById('ALT-1')).toEqual({
      ...b,
      status: 'RESOLVED',
      acknowledgedBy: null,
      acknowledgedAt: null,
      relatedLogIds: [],
      relatedMetricIds: [],
    });
  });

  it('C-AL-04 insert and upsertLivePreservingStatus over an existing id clear links', async () => {
    for (const op of ['insert', 'upsertLive'] as const) {
      const id = `ALT-${op}`;
      const logId = `log-${op}`;
      await repos.alerts.insert(makeAlert(id));
      await repos.logs.upsertMany([makeLog(logId, 1)], 'MOCK');
      await repos.logs.linkLogsToAlert(id, [logId]);
      const analysisId = await repos.aiAnalyses.insert(makeAnalysis({ alertId: id }));
      expect((await repos.logs.byAlert(id)).map((l) => l.id)).toEqual([logId]);
      expect((await repos.aiAnalyses.findById(analysisId))?.alertId).toBe(id);

      const again = makeAlert(id, { summary: 'Written again' });
      if (op === 'insert') await repos.alerts.insert(again);
      else await repos.alerts.upsertLivePreservingStatus(again);

      expect(await repos.logs.byAlert(id)).toEqual([]);
      expect((await repos.aiAnalyses.findById(analysisId))?.alertId).toBeNull();
      expect((await repos.alerts.findById(id))?.relatedLogIds).toEqual([]);
    }
  });

  it('C-AL-05 upsertLivePreservingStatus on a new id gives an OPEN LIVE alert', async () => {
    await repos.alerts.upsertLivePreservingStatus(makeAlert('ALT-L'));
    const got = await repos.alerts.findById('ALT-L');
    expect(got?.status).toBe('OPEN');
    expect(got?.acknowledgedBy).toBeNull();
    expect(got?.acknowledgedAt).toBeNull();
    expect(await repos.alerts.deleteByDataSource('MOCK')).toBe(0);
    expect(await repos.alerts.findById('ALT-L')).not.toBeNull();
    expect(await repos.alerts.deleteByDataSource('LIVE')).toBe(1);
    expect(await repos.alerts.findById('ALT-L')).toBeNull();
  });

  it('C-AL-06 upsertLivePreservingStatus keeps the acknowledgement and refreshes the body', async () => {
    await repos.alerts.upsertLivePreservingStatus(makeAlert('ALT-L'));
    const { value: acked, stamps: ackStamps } = await withStamps(() =>
      repos.alerts.acknowledge('ALT-L', 'ops@urbani.test'),
    );
    expect(ackStamps).toContain(acked?.acknowledgedAt);

    const refreshed = makeAlert('ALT-L', {
      summary: 'Refreshed summary',
      evidence: ['fresh evidence'],
      recommendedActions: ['fresh action'],
    });
    await repos.alerts.upsertLivePreservingStatus(refreshed);
    expect(await repos.alerts.findById('ALT-L')).toEqual({
      ...refreshed,
      status: 'ACKNOWLEDGED',
      acknowledgedBy: 'ops@urbani.test',
      acknowledgedAt: acked?.acknowledgedAt,
      relatedLogIds: [],
      relatedMetricIds: [],
    });
  });

  it('C-AL-07 upsertLivePreservingStatus over a MOCK alert flips it to LIVE and keeps its status', async () => {
    await repos.alerts.insert(makeAlert('ALT-M'), 'MOCK', 'RESOLVED');
    await repos.alerts.upsertLivePreservingStatus(makeAlert('ALT-M', { summary: 'Now live' }));
    const got = await repos.alerts.findById('ALT-M');
    expect(got?.status).toBe('RESOLVED');
    expect(got?.summary).toBe('Now live');
    expect(await repos.alerts.deleteByDataSource('MOCK')).toBe(0);
    expect(await repos.alerts.deleteByDataSource('LIVE')).toBe(1);
    expect(await repos.alerts.findById('ALT-M')).toBeNull();
  });

  it('C-AL-08 acknowledge moves OPEN to ACKNOWLEDGED once; a missing id returns null', async () => {
    await repos.alerts.insert(makeAlert('ALT-1'));
    const { value: first, stamps: s } = await withStamps(() => repos.alerts.acknowledge('ALT-1', 'alice@urbani.test'));
    expect(first?.status).toBe('ACKNOWLEDGED');
    expect(first?.acknowledgedBy).toBe('alice@urbani.test');
    expect(s).toContain(first?.acknowledgedAt);

    const second = await repos.alerts.acknowledge('ALT-1', 'bob@urbani.test');
    expect(second).toEqual(first);
    expect(await repos.alerts.findById('ALT-1')).toEqual(first);

    expect(await repos.alerts.acknowledge('ALT-NOPE', 'alice@urbani.test')).toBeNull();
    expect(await repos.alerts.findById('ALT-NOPE')).toBeNull();
  });

  it('C-AL-09 query single filters match exactly and case-sensitively; empty strings are ignored', async () => {
    await repos.alerts.insert(
      makeAlert('A1', { timestamp: at(1), service: 'main', environment: 'qa', severity: 'HIGH', anomalyType: 'Timeout' }),
    );
    await repos.alerts.insert(
      makeAlert('A2', {
        timestamp: at(2),
        service: 'payments',
        environment: 'prod',
        severity: 'LOW',
        anomalyType: 'OutOfMemory',
      }),
      'MOCK',
      'ACKNOWLEDGED',
    );
    await repos.alerts.insert(
      makeAlert('A3', {
        timestamp: at(3),
        service: 'main',
        environment: 'prod',
        severity: 'CRITICAL',
        anomalyType: 'Timeout',
      }),
      'MOCK',
      'RESOLVED',
    );
    const ids = async (f: Parameters<Repositories['alerts']['query']>[0]) =>
      (await repos.alerts.query(f)).items.map((a) => a.alertId);

    expect(await ids({ service: 'main' })).toEqual(['A3', 'A1']);
    expect(await ids({ service: 'Main' })).toEqual([]);
    expect(await ids({ service: 'mai' })).toEqual([]);
    expect(await ids({ environment: 'prod' })).toEqual(['A3', 'A2']);
    expect(await ids({ environment: 'PROD' })).toEqual([]);
    expect(await ids({ severity: 'LOW' })).toEqual(['A2']);
    expect(await ids({ severity: 'low' })).toEqual([]);
    expect(await ids({ anomalyType: 'Timeout' })).toEqual(['A3', 'A1']);
    expect(await ids({ anomalyType: 'timeout' })).toEqual([]);
    expect(await ids({ status: 'ACKNOWLEDGED' })).toEqual(['A2']);
    expect(await ids({ status: 'RESOLVED' })).toEqual(['A3']);
    expect(await ids({ status: 'open' })).toEqual([]);
    expect(await ids({ service: 'main', environment: 'prod' })).toEqual(['A3']);

    const empty = await repos.alerts.query({ service: '', environment: '', severity: '', anomalyType: '', status: '' });
    expect(empty.total).toBe(3);
    expect(empty.items.map((a) => a.alertId)).toEqual(['A3', 'A2', 'A1']);
  });

  it('C-AL-10 query from/to bounds are inclusive and compared as strings', async () => {
    await repos.alerts.insert(makeAlert('A1', { timestamp: at(10) }));
    await repos.alerts.insert(makeAlert('A2', { timestamp: at(20) }));
    await repos.alerts.insert(makeAlert('A3', { timestamp: at(30) }));
    const ids = async (f: { from?: string; to?: string }) =>
      (await repos.alerts.query(f)).items.map((a) => a.alertId);

    expect(await ids({ from: at(20) })).toEqual(['A3', 'A2']);
    expect(await ids({ to: at(20) })).toEqual(['A2', 'A1']);
    expect(await ids({ from: at(20), to: at(20) })).toEqual(['A2']);
    expect(await ids({ from: at(21), to: at(29) })).toEqual([]);
    // String comparison: '…00:00:20.000Z' < '…00:00:20Z' because '.' sorts before 'Z'.
    const noMillis = '2026-10-05T00:00:20Z';
    expect(await ids({ from: noMillis })).toEqual(['A3']);
    expect(await ids({ to: noMillis })).toEqual(['A2', 'A1']);
  });

  it('C-AL-11 query search is ASCII case-insensitive across summary, anomalyType and probableCause', async () => {
    await repos.alerts.insert(
      makeAlert('A1', {
        timestamp: at(1),
        summary: 'DB connection pool exhausted',
        anomalyType: 'DatabaseConnectionTimeout',
        probableCause: 'Unclosed sessions',
      }),
    );
    await repos.alerts.insert(
      makeAlert('A2', {
        timestamp: at(2),
        summary: 'Memory pressure on payments',
        anomalyType: 'OutOfMemory',
        probableCause: 'Heap leak in worker',
      }),
    );
    const ids = async (search: string) => (await repos.alerts.query({ search })).items.map((a) => a.alertId);

    expect(await ids('CONNECTION POOL')).toEqual(['A1']);
    expect(await ids('timeout')).toEqual(['A1']);
    expect(await ids('HEAP LEAK')).toEqual(['A2']);
    expect(await ids('po_l')).toEqual(['A1']);
    expect(await ids('po__l')).toEqual([]);
    expect(await ids('memory%payments')).toEqual(['A2']);
    expect(await ids('connection%exhausted')).toEqual(['A1']);
    expect(await ids('exhausted%connection')).toEqual([]);
    const miss = await repos.alerts.query({ search: 'zzz' });
    expect(miss.total).toBe(0);
    expect(miss.items).toEqual([]);
  });

  it('C-AL-12 query sorts by timestamp descending, counts all matches and clamps paging', async () => {
    for (let i = 0; i <= 200; i++) {
      await repos.alerts.insert(makeAlert(`ALT-${pad(i)}`, { timestamp: at(i), evidence: [], recommendedActions: [] }));
    }
    const first = await repos.alerts.query({});
    expect(first.total).toBe(201);
    expect(first.items[0].alertId).toBe('ALT-200');

    const big = await repos.alerts.query({ pageSize: 500 });
    expect(big.items).toHaveLength(200);
    expect(big.total).toBe(201);
    expectDescending(big.items.map((a) => a.timestamp));

    const one = await repos.alerts.query({ pageSize: 0 });
    expect(one.items.map((a) => a.alertId)).toEqual(['ALT-200']);
    expect(one.total).toBe(201);

    const pageZero = await repos.alerts.query({ page: 0, pageSize: 10 });
    const pageOne = await repos.alerts.query({ page: 1, pageSize: 10 });
    expect(pageZero.items.map((a) => a.alertId)).toEqual(pageOne.items.map((a) => a.alertId));

    const tail = await repos.alerts.query({ page: 2, pageSize: 200 });
    expect(tail.items.map((a) => a.alertId)).toEqual(['ALT-000']);

    const past = await repos.alerts.query({ page: 100, pageSize: 10 });
    expect(past.items).toEqual([]);
    expect(past.total).toBe(201);
  });

  it('C-AL-13 replaceDerivedEvidence writes, replaces and clears, and never creates an alert', async () => {
    await repos.alerts.insert(makeAlert('ALT-1', { evidence: ['original'] }));
    await repos.alerts.replaceDerivedEvidence('ALT-1', ['line a', 'line b']);
    expect((await repos.alerts.findById('ALT-1'))?.evidence).toEqual(['line a', 'line b']);
    await repos.alerts.replaceDerivedEvidence('ALT-1', ['line c']);
    expect((await repos.alerts.findById('ALT-1'))?.evidence).toEqual(['line c']);
    await repos.alerts.replaceDerivedEvidence('ALT-1', []);
    expect((await repos.alerts.findById('ALT-1'))?.evidence).toEqual([]);

    await expect(repos.alerts.replaceDerivedEvidence('ALT-NOPE', [])).resolves.toBeUndefined();
    expect(await repos.alerts.findById('ALT-NOPE')).toBeNull();
    await expect(repos.alerts.replaceDerivedEvidence('ALT-NOPE', ['orphan line'])).rejects.toThrow();
    expect(await repos.alerts.findById('ALT-NOPE')).toBeNull();
  });

  it('C-AL-14 deleteByDataSource returns the count, deletes only that source and unlinks children', async () => {
    await repos.alerts.insert(makeAlert('M1', { timestamp: at(1) }));
    await repos.alerts.insert(makeAlert('M2', { timestamp: at(2) }));
    await repos.alerts.upsertLivePreservingStatus(makeAlert('L1', { timestamp: at(3) }));
    await repos.logs.upsertMany([makeLog('log-1', 1), makeLog('log-2', 2)], 'MOCK');
    await repos.logs.linkLogsToAlert('M1', ['log-1']);
    await repos.logs.linkLogsToAlert('L1', ['log-2']);
    const analysisId = await repos.aiAnalyses.insert(makeAnalysis({ alertId: 'M1' }));

    expect(await repos.alerts.deleteByDataSource('MOCK')).toBe(2);
    expect(await repos.alerts.findById('M1')).toBeNull();
    expect(await repos.alerts.findById('M2')).toBeNull();
    expect(await repos.alerts.findById('L1')).not.toBeNull();
    expect(await repos.logs.byAlert('M1')).toEqual([]);
    expect((await repos.logs.byAlert('L1')).map((l) => l.id)).toEqual(['log-2']);
    expect((await repos.logs.query({})).total).toBe(2);
    expect((await repos.aiAnalyses.findById(analysisId))?.alertId).toBeNull();
    expect(await repos.alerts.deleteByDataSource('MOCK')).toBe(0);
  });

  it('C-AL-15 countAll, countActive and countBySeverity', async () => {
    await repos.alerts.insert(makeAlert('A1', { timestamp: at(1), severity: 'HIGH' }), 'MOCK', 'OPEN');
    await repos.alerts.insert(makeAlert('A2', { timestamp: at(2), severity: 'HIGH' }), 'MOCK', 'ACKNOWLEDGED');
    await repos.alerts.insert(makeAlert('A3', { timestamp: at(3), severity: 'HIGH' }), 'MOCK', 'RESOLVED');
    await repos.alerts.insert(makeAlert('A4', { timestamp: at(4), severity: 'LOW' }), 'MOCK', 'DISMISSED');
    await repos.alerts.insert(makeAlert('A5', { timestamp: at(5), severity: 'CRITICAL' }), 'MOCK', 'OPEN');

    expect(await repos.alerts.countAll()).toBe(5);
    expect(await repos.alerts.countActive()).toBe(3);
    expect(await repos.alerts.countBySeverity('HIGH')).toBe(2);
    expect(await repos.alerts.countBySeverity('LOW')).toBe(0);
    expect(await repos.alerts.countBySeverity('CRITICAL')).toBe(1);
    expect(await repos.alerts.countBySeverity('MEDIUM')).toBe(0);
  });

  it('C-AL-16 relatedLogIds reflects links in findById and in query items', async () => {
    await repos.alerts.insert(makeAlert('A1', { timestamp: at(1) }));
    await repos.alerts.insert(makeAlert('A2', { timestamp: at(2) }));
    await repos.logs.upsertMany([makeLog('l1', 1), makeLog('l2', 2), makeLog('l3', 3)], 'MOCK');
    await repos.logs.linkLogsToAlert('A1', ['l3', 'l1']);
    await repos.logs.linkLogsToAlert('A2', ['l2']);

    expect(sorted((await repos.alerts.findById('A1'))?.relatedLogIds ?? [])).toEqual(['l1', 'l3']);
    expect((await repos.alerts.findById('A2'))?.relatedLogIds).toEqual(['l2']);
    const items = (await repos.alerts.query({})).items;
    expect(sorted(items.find((a) => a.alertId === 'A1')?.relatedLogIds ?? [])).toEqual(['l1', 'l3']);
    expect(items.find((a) => a.alertId === 'A2')?.relatedLogIds).toEqual(['l2']);
  });

  // ---------------------------------------------------------------- Logs

  it('C-LG-01 upsertMany then query: filters, search, total, order, default page size and clamps', async () => {
    const logs: LogEntry[] = [];
    for (let i = 0; i <= 200; i++) {
      logs.push(
        makeLog(`log-${pad(i)}`, i, {
          service: i % 3 === 0 ? 'payments' : 'main',
          environment: i % 2 === 0 ? 'qa' : 'prod',
          level: i % 5 === 0 ? 'WARN' : 'ERROR',
          message: i === 7 ? 'Connection RESET by peer' : `request ${i} failed`,
        }),
      );
    }
    await repos.logs.upsertMany(logs, 'MOCK');
    const expectIds = (pred: (l: LogEntry) => boolean) =>
      logs.filter(pred).map((l) => l.id).reverse();

    const all = await repos.logs.query({});
    expect(all.total).toBe(201);
    expect(all.items).toHaveLength(50);
    expect(all.items[0]).toEqual(logs[200]);

    const byService = await repos.logs.query({ service: 'payments', pageSize: 200 });
    expect(byService.items.map((l) => l.id)).toEqual(expectIds((l) => l.service === 'payments'));
    expect(byService.total).toBe(byService.items.length);
    const byEnv = await repos.logs.query({ environment: 'prod', pageSize: 200 });
    expect(byEnv.items.map((l) => l.id)).toEqual(expectIds((l) => l.environment === 'prod'));
    const byLevel = await repos.logs.query({ level: 'WARN', pageSize: 200 });
    expect(byLevel.items.map((l) => l.id)).toEqual(expectIds((l) => l.level === 'WARN'));
    expect(byLevel.total).toBe(41);
    const combined = await repos.logs.query({ service: 'main', environment: 'qa', level: 'ERROR', pageSize: 200 });
    expect(combined.items.map((l) => l.id)).toEqual(
      expectIds((l) => l.service === 'main' && l.environment === 'qa' && l.level === 'ERROR'),
    );
    expect(combined.total).toBe(combined.items.length);
    expect((await repos.logs.query({ service: 'MAIN' })).total).toBe(0);

    const search = await repos.logs.query({ search: 'connection reset' });
    expect(search.items.map((l) => l.id)).toEqual(['log-007']);
    const wildcard = await repos.logs.query({ search: 'request 1_0', pageSize: 200 });
    expect(wildcard.total).toBe(10);
    expect(wildcard.items.map((l) => l.id)).toEqual(
      [190, 180, 170, 160, 150, 140, 130, 120, 110, 100].map((i) => `log-${pad(i)}`),
    );

    const big = await repos.logs.query({ pageSize: 500 });
    expect(big.items).toHaveLength(200);
    expectDescending(big.items.map((l) => l.timestamp));
    expect((await repos.logs.query({ pageSize: 0 })).items.map((l) => l.id)).toEqual(['log-200']);
    const pageZero = await repos.logs.query({ page: 0, pageSize: 5 });
    const pageOne = await repos.logs.query({ page: 1, pageSize: 5 });
    expect(pageZero.items).toEqual(pageOne.items);
    const past = await repos.logs.query({ page: 50 });
    expect(past.items).toEqual([]);
    expect(past.total).toBe(201);
  });

  it('C-LG-02 upsertMany over an existing id replaces the row and clears its link', async () => {
    await repos.alerts.insert(makeAlert('A1'));
    await repos.logs.upsertMany([makeLog('log-1', 1, { message: 'old message' })], 'MOCK');
    await repos.logs.linkLogsToAlert('A1', ['log-1']);
    expect((await repos.logs.byAlert('A1')).map((l) => l.id)).toEqual(['log-1']);

    const replaced = makeLog('log-1', 2, { message: 'new message', level: 'INFO' });
    await repos.logs.upsertMany([replaced], 'MOCK');
    expect(await repos.logs.byAlert('A1')).toEqual([]);
    expect((await repos.alerts.findById('A1'))?.relatedLogIds).toEqual([]);
    const q = await repos.logs.query({});
    expect(q.total).toBe(1);
    expect(q.items).toEqual([replaced]);
  });

  it('C-LG-03 linkLogsToAlert links existing ids, byAlert sorts descending, absent ids are ignored', async () => {
    await repos.alerts.insert(makeAlert('A1'));
    const l1 = makeLog('l1', 1);
    const l2 = makeLog('l2', 2);
    const l3 = makeLog('l3', 3);
    await repos.logs.upsertMany([l1, l2, l3], 'MOCK');
    await repos.logs.linkLogsToAlert('A1', ['l1', 'l3', 'absent']);
    expect(await repos.logs.byAlert('A1')).toEqual([l3, l1]);
    expect((await repos.logs.query({})).total).toBe(3);
  });

  it('C-LG-04 linkLogsToAlert edge cases: [] is a no-op, a missing alert rejects only for existing logs', async () => {
    await repos.alerts.insert(makeAlert('A1'));
    await repos.logs.upsertMany([makeLog('l1', 1)], 'MOCK');
    await repos.logs.linkLogsToAlert('A1', []);
    expect(await repos.logs.byAlert('A1')).toEqual([]);

    await expect(repos.logs.linkLogsToAlert('ALT-NOPE', ['l1'])).rejects.toThrow();
    expect(await repos.logs.byAlert('ALT-NOPE')).toEqual([]);
    await expect(repos.logs.linkLogsToAlert('ALT-NOPE', ['absent-1', 'absent-2'])).resolves.toBeUndefined();
    expect(await repos.alerts.findById('ALT-NOPE')).toBeNull();
  });

  it('C-LG-05 clearAlertLinks clears only that alert', async () => {
    await repos.alerts.insert(makeAlert('A1', { timestamp: at(1) }));
    await repos.alerts.insert(makeAlert('A2', { timestamp: at(2) }));
    await repos.logs.upsertMany([makeLog('l1', 1), makeLog('l2', 2), makeLog('l3', 3)], 'MOCK');
    await repos.logs.linkLogsToAlert('A1', ['l1', 'l2']);
    await repos.logs.linkLogsToAlert('A2', ['l3']);
    await repos.logs.clearAlertLinks('A1');
    expect(await repos.logs.byAlert('A1')).toEqual([]);
    expect((await repos.logs.byAlert('A2')).map((l) => l.id)).toEqual(['l3']);
    expect((await repos.logs.query({})).total).toBe(3);
  });

  it('C-LG-06 re-linking a log to a different alert moves the link', async () => {
    await repos.alerts.insert(makeAlert('A1', { timestamp: at(1) }));
    await repos.alerts.insert(makeAlert('A2', { timestamp: at(2) }));
    await repos.logs.upsertMany([makeLog('l1', 1)], 'MOCK');
    await repos.logs.linkLogsToAlert('A1', ['l1']);
    await repos.logs.linkLogsToAlert('A2', ['l1']);
    expect(await repos.logs.byAlert('A1')).toEqual([]);
    expect((await repos.logs.byAlert('A2')).map((l) => l.id)).toEqual(['l1']);
    expect((await repos.alerts.findById('A1'))?.relatedLogIds).toEqual([]);
    expect((await repos.alerts.findById('A2'))?.relatedLogIds).toEqual(['l1']);
  });

  // ---------------------------------------------------------------- Metrics

  it('C-MT-01 metrics query: filters, descending order, default limit 200, clamp to 500, limit 0', async () => {
    const metrics: MetricSnapshot[] = [];
    for (let i = 0; i <= 500; i++) {
      metrics.push(
        makeMetric(`met-${pad(i)}`, i, {
          service: i % 2 === 0 ? 'main' : 'payments',
          environment: i % 3 === 0 ? 'prod' : 'qa',
          requestCount: i,
        }),
      );
    }
    await repos.metrics.upsertMany(metrics, 'MOCK');
    const expectIds = (pred: (m: MetricSnapshot) => boolean) =>
      metrics.filter(pred).map((m) => m.id).reverse();

    const def = await repos.metrics.query({});
    expect(def).toHaveLength(200);
    expect(def[0]).toEqual(metrics[500]);
    expectDescending(def.map((m) => m.timestamp));
    expect(await repos.metrics.query({ limit: 1000 })).toHaveLength(500);
    expect(await repos.metrics.query({ limit: 0 })).toEqual([]);

    const main = await repos.metrics.query({ service: 'main', limit: 500 });
    expect(main.map((m) => m.id)).toEqual(expectIds((m) => m.service === 'main'));
    const prodMain = await repos.metrics.query({ service: 'main', environment: 'prod', limit: 500 });
    expect(prodMain.map((m) => m.id)).toEqual(expectIds((m) => m.service === 'main' && m.environment === 'prod'));
    expect(await repos.metrics.query({ service: 'Main' })).toEqual([]);
  });

  it('C-MT-02 an alert has no relatedMetricIds', async () => {
    await repos.metrics.upsertMany([makeMetric('met-1', 1), makeMetric('met-2', 2)], 'MOCK');
    await repos.alerts.insert(makeAlert('A1'));
    expect((await repos.alerts.findById('A1'))?.relatedMetricIds).toEqual([]);
    expect((await repos.alerts.query({})).items[0].relatedMetricIds).toEqual([]);
  });

  // ---------------------------------------------------------------- Services and environments

  it('C-SV-01 services.upsert then all sorted by name with alertCount over any status', async () => {
    const payments = makeService('svc-payments', 'payments');
    const main = makeService('svc-main', 'main', { status: 'DEGRADED', errorRate: 0.2, lastIncidentAt: at(3) });
    const auth = makeService('svc-auth', 'auth', { environment: 'prod', status: 'DOWN', lastTelemetryAt: null });
    await repos.services.upsert(payments, 'MOCK');
    await repos.services.upsert(main, 'MOCK');
    await repos.services.upsert(auth, 'MOCK');
    await repos.alerts.insert(makeAlert('A1', { timestamp: at(1), service: 'main' }), 'MOCK', 'OPEN');
    await repos.alerts.insert(makeAlert('A2', { timestamp: at(2), service: 'main' }), 'MOCK', 'RESOLVED');
    await repos.alerts.insert(makeAlert('A3', { timestamp: at(3), service: 'payments' }), 'MOCK', 'ACKNOWLEDGED');
    await repos.alerts.insert(makeAlert('A4', { timestamp: at(4), service: 'Main' }), 'MOCK', 'OPEN');

    expect(await repos.services.all()).toEqual([
      { ...auth, alertCount: 0 },
      { ...main, alertCount: 2 },
      { ...payments, alertCount: 1 },
    ]);
  });

  it('C-SV-02 services.findById includes alertCount; a missing id returns null; count', async () => {
    const main = makeService('svc-main', 'main');
    await repos.services.upsert(main, 'MOCK');
    await repos.alerts.insert(makeAlert('A1', { service: 'main' }));
    expect(await repos.services.findById('svc-main')).toEqual({ ...main, alertCount: 1 });
    expect(await repos.services.findById('svc-nope')).toBeNull();
    expect(await repos.services.count()).toBe(1);
    await repos.services.upsert(makeService('svc-payments', 'payments'), 'MOCK');
    expect(await repos.services.count()).toBe(2);
  });

  it('C-SV-03 environments.ensure is idempotent and never overwrites; all sorts by name', async () => {
    const { stamps: s } = await withStamps(() => repos.environments.ensure({ id: 'env-qa', name: 'qa' }));
    await repos.environments.ensure({ id: 'env-qa', name: 'qa-renamed' });
    await repos.environments.ensure({ id: 'env-dev', name: 'dev' });
    await repos.environments.ensure({ id: 'env-dev', name: 'dev' });
    const all = await repos.environments.all();
    expect(all.map((e) => [e.id, e.name])).toEqual([
      ['env-dev', 'dev'],
      ['env-qa', 'qa'],
    ]);
    expect(s).toContain(all[1].createdAt);
  });

  // ---------------------------------------------------------------- Usage

  it('C-US-01 usage.upsertMany then all sorted by date descending', async () => {
    const rec = (id: string, date: string, cost: number): UsageRecord => ({
      id,
      date,
      modelId: 'model-test',
      aiRequestCount: 5,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: cost,
    });
    const u1 = rec('use-1', '2026-10-02', 0.1);
    const u2 = rec('use-2', '2026-10-04', 0.2);
    const u3 = rec('use-3', '2026-10-03', 0.3);
    await repos.usage.upsertMany([u1, u2, u3], 'MOCK');
    expect(await repos.usage.all()).toEqual([u2, u3, u1]);
  });

  // ---------------------------------------------------------------- AI analyses

  it('C-AI-01 aiAnalyses.insert generates an id and round-trips a finding object and a null finding', async () => {
    const withFinding = makeAnalysis({ finding: makeAlert('ALT-F'), confidence: 0.9 });
    const id = await repos.aiAnalyses.insert(withFinding);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(await repos.aiAnalyses.findById(id)).toEqual({ ...withFinding, id });

    const noFinding = makeAnalysis({ timestamp: at(1), finding: null, anomalyType: null, confidence: null });
    const id2 = await repos.aiAnalyses.insert(noFinding);
    expect(id2).not.toBe(id);
    expect(await repos.aiAnalyses.findById(id2)).toEqual({ ...noFinding, id: id2 });
    expect(await repos.aiAnalyses.findById('an-missing')).toBeNull();
  });

  it('C-AI-02 a provided id is used; a duplicate id rejects', async () => {
    expect(await repos.aiAnalyses.insert(makeAnalysis({ id: 'an-fixed' }))).toBe('an-fixed');
    expect((await repos.aiAnalyses.findById('an-fixed'))?.id).toBe('an-fixed');
    await expect(repos.aiAnalyses.insert(makeAnalysis({ id: 'an-fixed', timestamp: at(1) }))).rejects.toThrow();
    expect(await repos.aiAnalyses.count()).toBe(1);
  });

  it('C-AI-03 aiAnalyses.query sorts descending, returns total, default page size 25', async () => {
    for (let i = 0; i <= 25; i++) {
      await repos.aiAnalyses.insert(makeAnalysis({ id: `an-${pad(i)}`, timestamp: at(i) }));
    }
    const first = await repos.aiAnalyses.query({});
    expect(first.total).toBe(26);
    expect(first.items).toHaveLength(25);
    expect(first.items[0].id).toBe('an-025');
    expectDescending(first.items.map((a) => a.timestamp));
    const second = await repos.aiAnalyses.query({ page: 2 });
    expect(second.items.map((a) => a.id)).toEqual(['an-000']);
    expect(second.total).toBe(26);
  });

  it('C-AI-04 aiAnalyses.count', async () => {
    expect(await repos.aiAnalyses.count()).toBe(0);
    for (let i = 0; i < 3; i++) await repos.aiAnalyses.insert(makeAnalysis({ timestamp: at(i) }));
    expect(await repos.aiAnalyses.count()).toBe(3);
  });

  it('C-AI-05 an alertId pointing at a missing alert rejects', async () => {
    await expect(repos.aiAnalyses.insert(makeAnalysis({ alertId: 'ALT-MISSING' }))).rejects.toThrow();
    expect(await repos.aiAnalyses.count()).toBe(0);
    await repos.alerts.insert(makeAlert('ALT-1'));
    const id = await repos.aiAnalyses.insert(makeAnalysis({ alertId: 'ALT-1' }));
    expect((await repos.aiAnalyses.findById(id))?.alertId).toBe('ALT-1');
  });

  // ---------------------------------------------------------------- Audit

  it('C-AU-01 audit.record then query round-trips actor, action, target and metadata', async () => {
    const metadata = { theme: 'dark', nested: { list: [1, 2, 3], flag: true } };
    const { stamps: s } = await withStamps(() =>
      repos.audit.record('alice@urbani.test', 'CONFIG_CHANGED', 'settings', metadata),
    );
    await repos.audit.record('bob@urbani.test', 'LOGIN');
    const q = await repos.audit.query({});
    expect(q.total).toBe(2);
    const [bob, alice] = q.items;
    expect(bob).toEqual({
      id: expect.any(String),
      timestamp: expect.any(String),
      actor: 'bob@urbani.test',
      action: 'LOGIN',
      target: null,
      metadata: null,
    });
    expect(alice).toEqual({
      id: expect.any(String),
      timestamp: expect.any(String),
      actor: 'alice@urbani.test',
      action: 'CONFIG_CHANGED',
      target: 'settings',
      metadata,
    });
    expect(s).toContain(alice.timestamp);
    expect(alice.id).not.toBe(bob.id);
  });

  it('C-AU-02 audit.query filters by action and actor; descending; total; default page size 50; clamps', async () => {
    const events: Array<{ actor: string; action: AuditAction }> = [];
    for (let i = 0; i <= 200; i++) {
      const e = {
        actor: i % 2 === 0 ? 'bob@urbani.test' : 'alice@urbani.test',
        action: (i % 3 === 0 ? 'LOGIN' : 'ALERT_VIEWED') as AuditAction,
      };
      events.push(e);
      await repos.audit.record(e.actor, e.action);
    }
    const count = (pred: (e: { actor: string; action: AuditAction }) => boolean) => events.filter(pred).length;

    const all = await repos.audit.query({});
    expect(all.total).toBe(201);
    expect(all.items).toHaveLength(50);
    expectDescending(all.items.map((e) => e.timestamp));

    const logins = await repos.audit.query({ action: 'LOGIN', pageSize: 200 });
    expect(logins.total).toBe(count((e) => e.action === 'LOGIN'));
    expect(logins.items.every((e) => e.action === 'LOGIN')).toBe(true);
    const alice = await repos.audit.query({ actor: 'alice@urbani.test', pageSize: 200 });
    expect(alice.total).toBe(count((e) => e.actor === 'alice@urbani.test'));
    expect(alice.items.every((e) => e.actor === 'alice@urbani.test')).toBe(true);
    const both = await repos.audit.query({ action: 'LOGIN', actor: 'alice@urbani.test', pageSize: 200 });
    expect(both.total).toBe(count((e) => e.action === 'LOGIN' && e.actor === 'alice@urbani.test'));
    expect(both.items).toHaveLength(both.total);
    expect(both.items.every((e) => e.action === 'LOGIN' && e.actor === 'alice@urbani.test')).toBe(true);
    expectDescending(both.items.map((e) => e.timestamp));

    expect((await repos.audit.query({ pageSize: 500 })).items).toHaveLength(200);
    const one = await repos.audit.query({ pageSize: 0 });
    expect(one.items).toHaveLength(1);
    expect(one.items[0]).toEqual(all.items[0]);
    const pageZero = await repos.audit.query({ page: 0, pageSize: 5 });
    const pageOne = await repos.audit.query({ page: 1, pageSize: 5 });
    expect(pageZero.items).toEqual(pageOne.items);
    const past = await repos.audit.query({ page: 99 });
    expect(past.items).toEqual([]);
    expect(past.total).toBe(201);
  });

  it('C-AU-03 audit.query items have exactly the AuditEvent keys and no result', async () => {
    await repos.audit.record('alice@urbani.test', 'ALERT_VIEWED', 'ALT-1', { a: 1 }, 'FAILURE');
    const [item] = (await repos.audit.query({})).items;
    expect(Object.keys(item).sort()).toEqual(['action', 'actor', 'id', 'metadata', 'target', 'timestamp']);
    expect('result' in item).toBe(false);
  });

  it('C-AU-04 result defaults to SUCCESS; FAILURE and DENIED are stored; an invalid value is rejected', async () => {
    await repos.audit.record('a@urbani.test', 'LOGIN');
    await repos.audit.record('a@urbani.test', 'LOGIN', undefined, undefined, 'FAILURE');
    await repos.audit.record('a@urbani.test', 'LOGIN', undefined, undefined, 'DENIED');
    await expectReason(
      repos.audit.record('a@urbani.test', 'LOGIN', undefined, undefined, 'BOGUS' as AuditResult),
      'INVALID_ARGUMENT',
    );
    const page = await repos.audit.listByTimeRange({});
    expect(page.items.map((e) => e.result)).toEqual(['DENIED', 'FAILURE', 'SUCCESS']);
    expect((await repos.audit.query({})).total).toBe(3);
  });

  it('C-AU-05 listByTimeRange with inclusive bounds, newest first, with and without actor', async () => {
    const s: string[] = [];
    const actors = ['alice@urbani.test', 'bob@urbani.test', 'alice@urbani.test', 'bob@urbani.test', 'alice@urbani.test'];
    for (const actor of actors) {
      const r = await withStamps(() => repos.audit.record(actor, 'ALERT_VIEWED', 'ALT-1', { n: s.length }));
      s.push(r.stamps[r.stamps.length - 1]);
    }
    const ts = (p: CursorPage<AuditEventRecord>) => p.items.map((e) => e.timestamp);

    const range = await repos.audit.listByTimeRange({ from: s[1], to: s[3] });
    expect(ts(range)).toEqual([s[3], s[2], s[1]]);
    expect(range.nextCursor).toBeNull();
    expect(range.items[0]).toEqual({
      id: expect.any(String),
      timestamp: s[3],
      actor: 'bob@urbani.test',
      action: 'ALERT_VIEWED',
      target: 'ALT-1',
      metadata: { n: 3 },
      result: 'SUCCESS',
    });
    expect(ts(await repos.audit.listByTimeRange({ from: s[1], to: s[3], actor: 'alice@urbani.test' }))).toEqual([s[2]]);
    expect(ts(await repos.audit.listByTimeRange({ from: s[1], to: s[3], actor: 'bob@urbani.test' }))).toEqual([s[3], s[1]]);
    expect(ts(await repos.audit.listByTimeRange({}))).toEqual([...s].reverse());
    expect(ts(await repos.audit.listByTimeRange({ actor: 'alice@urbani.test' }))).toEqual([s[4], s[2], s[0]]);
    expect(ts(await repos.audit.listByTimeRange({ from: s[3] }))).toEqual([s[4], s[3]]);
    expect(ts(await repos.audit.listByTimeRange({ to: s[1] }))).toEqual([s[1], s[0]]);
    expect((await repos.audit.listByTimeRange({ actor: 'nobody@urbani.test' })).items).toEqual([]);
  });

  it('C-AU-06 listByTimeRange pages with limit 2 over 5 events: 3 pages, no duplicates or gaps', async () => {
    for (let i = 0; i < 5; i++) await repos.audit.record('alice@urbani.test', 'LOGIN', `t-${i}`);
    const full = await repos.audit.listByTimeRange({});
    const { pages, cursors } = await collectPages((cursor) => repos.audit.listByTimeRange({ limit: 2, cursor }));
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(cursors[0]).not.toBeNull();
    expect(cursors[1]).not.toBeNull();
    expect(cursors[2]).toBeNull();
    const ids = pages.flat().map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(full.items.map((e) => e.id));
  });

  it('C-AU-07 listByTimeRange rejects bad cursors and from > to, and clamps limit', async () => {
    const s: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await withStamps(() => repos.audit.record('alice@urbani.test', 'LOGIN'));
      s.push(r.stamps[r.stamps.length - 1]);
    }
    await expectReason(repos.audit.listByTimeRange({ cursor: '%%%not-a-cursor%%%' }), 'INVALID_CURSOR');
    await expectReason(
      repos.audit.listByTimeRange({ cursor: Buffer.from('{"v":2,"k":[]}', 'utf8').toString('base64url') }),
      'INVALID_CURSOR',
    );
    await expectReason(
      repos.audit.listByTimeRange({ from: s[1], to: s[3], cursor: encodeCursor([s[4], 'id-x']) }),
      'INVALID_CURSOR',
    );
    await expectReason(
      repos.audit.listByTimeRange({ from: s[1], to: s[3], cursor: encodeCursor([s[0], 'id-x']) }),
      'INVALID_CURSOR',
    );
    await expectReason(
      repos.audit.listByTimeRange({ cursor: encodeCursor(['2026-10-01T00:00:00Z', 'id-x']) }),
      'INVALID_CURSOR',
    );
    await expectReason(repos.audit.listByTimeRange({ from: s[3], to: s[1] }), 'INVALID_ARGUMENT');

    // A cursor issued for the range keeps working inside it.
    const p1 = await repos.audit.listByTimeRange({ from: s[1], to: s[3], limit: 1 });
    expect(p1.items.map((e) => e.timestamp)).toEqual([s[3]]);
    const p2 = await repos.audit.listByTimeRange({ from: s[1], to: s[3], limit: 1, cursor: p1.nextCursor ?? undefined });
    expect(p2.items.map((e) => e.timestamp)).toEqual([s[2]]);

    const zero = await repos.audit.listByTimeRange({ limit: 0 });
    expect(zero.items).toHaveLength(1);
    expect(zero.nextCursor).not.toBeNull();
    expect((await repos.audit.listByTimeRange({ limit: -3 })).items).toHaveLength(1);
    for (let i = 0; i < 196; i++) await repos.audit.record('bob@urbani.test', 'ALERT_VIEWED');
    const capped = await repos.audit.listByTimeRange({ limit: 500 });
    expect(capped.items).toHaveLength(200);
    expect(capped.nextCursor).not.toBeNull();
    expect((await repos.audit.listByTimeRange({})).items).toHaveLength(50);
  });

  it('C-AU-08 listByTimeRange filters by actions, result, text and metadata substring; cursor works with filters', async () => {
    await repos.audit.record('a@urbani.test', 'LOGIN');
    await repos.audit.record('a@urbani.test', 'auth.login_failed', undefined, undefined, 'FAILURE');
    await repos.audit.record('b@urbani.test', 'chat.query', 'chat', { questionPreview: 'Why is Main failing?' });
    await repos.audit.record('b@urbani.test', 'logs.search', 'logs', { level: 'ERROR', ctx: { userId: 'u-1' } });
    await repos.audit.record('b@urbani.test', 'logs.search', 'logs', { level: 'INFO', ctx: { userId: 'u-2' } });
    const actions = (p: CursorPage<AuditEventRecord>) => p.items.map((e) => e.action);
    expect(actions(await repos.audit.listByTimeRange({ actions: ['logs.search', 'LOGIN'] }))).toEqual(['logs.search', 'logs.search', 'LOGIN']);
    expect((await repos.audit.listByTimeRange({ actions: [] })).items).toEqual([]);
    expect(actions(await repos.audit.listByTimeRange({ result: 'FAILURE' }))).toEqual(['auth.login_failed']);
    expect(actions(await repos.audit.listByTimeRange({ text: 'WHY IS MAIN' }))).toEqual(['chat.query']);
    expect(actions(await repos.audit.listByTimeRange({ text: 'chat' }))).toEqual(['chat.query']);
    expect(actions(await repos.audit.listByTimeRange({ metadataContains: '"userId":"u-2"' }))).toEqual(['logs.search']);
    expect(actions(await repos.audit.listByTimeRange({ actor: 'b@urbani.test', actions: ['logs.search'], result: 'SUCCESS' }))).toEqual(['logs.search', 'logs.search']);
    const { pages } = await collectPages((cursor) => repos.audit.listByTimeRange({ actions: ['logs.search', 'LOGIN'], limit: 1, cursor }));
    expect(pages.flat().map((e) => e.action)).toEqual(['logs.search', 'logs.search', 'LOGIN']);
  });

  it('C-AU-09 purgeOlderThan deletes only events strictly before the cutoff and returns the count', async () => {
    const s: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await withStamps(() => repos.audit.record('a@urbani.test', 'LOGIN', `t-${i}`));
      s.push(r.stamps[r.stamps.length - 1]);
    }
    expect(await repos.audit.purgeOlderThan(s[2])).toBe(2);
    expect((await repos.audit.listByTimeRange({})).items.map((e) => e.target)).toEqual(['t-3', 't-2']);
    expect(await repos.audit.purgeOlderThan(s[2])).toBe(0);
  });

  // ---------------------------------------------------------------- Integrations

  it('C-IN-01 integrations.upsert then all sorted by kind; same id replaces; delete removes', async () => {
    const a = makeIntegration('int-a', 'URBANI_APP');
    const b = makeIntegration('int-b', 'BEDROCK');
    const c = makeIntegration('int-c', 'CLOUDWATCH');
    await repos.integrations.upsert(a);
    await repos.integrations.upsert(b);
    await repos.integrations.upsert(c);
    expect(await repos.integrations.all()).toEqual([b, c, a]);

    const b2 = { ...b, status: 'CONNECTED', mode: 'LIVE', config_json: '{"x":1}', updated_at: at(9) };
    await repos.integrations.upsert(b2);
    expect(await repos.integrations.all()).toEqual([b2, c, a]);

    await repos.integrations.delete('int-c');
    expect(await repos.integrations.all()).toEqual([b2, a]);
    await expect(repos.integrations.delete('int-missing')).resolves.toBeUndefined();
    expect(await repos.integrations.all()).toEqual([b2, a]);
  });

  // ---------------------------------------------------------------- Users and roles

  it('C-UR-01 upsertRole then getRole; a missing id returns null', async () => {
    await repos.users.upsertRole(ADMIN_ROLE);
    expect(await repos.users.getRole('role-admin')).toEqual(ADMIN_ROLE);
    expect(await repos.users.getRole('role-nope')).toBeNull();
  });

  it('C-UR-02 upsertUser then findByEmail and findById; role defaults to SUPER_ADMIN; all roles accepted', async () => {
    const u = await addUser('u1', 'u1@urbani.test');
    expect(await repos.users.findByEmail('u1@urbani.test')).toEqual({ ...u, role: 'SUPER_ADMIN' });
    expect(await repos.users.findById('u1')).toEqual({ ...u, role: 'SUPER_ADMIN' });
    for (const role of USER_ROLES) {
      await repos.users.upsertUser(makeUser(`u-${role}`, `${role.toLowerCase()}@urbani.test`, { role }));
      expect((await repos.users.findById(`u-${role}`))?.role).toBe(role);
      expect((await repos.users.findByEmail(`${role.toLowerCase()}@urbani.test`))?.id).toBe(`u-${role}`);
    }
  });

  it('C-UR-03 an inactive user is invisible to both lookups', async () => {
    await addUser('u1', 'inactive@urbani.test', { is_active: 0 });
    expect(await repos.users.findByEmail('inactive@urbani.test')).toBeNull();
    expect(await repos.users.findById('u1')).toBeNull();
  });

  it('C-UR-04 toAuthUser takes the role name from the roles table and parses permissions', async () => {
    await addUser('u1', 'u1@urbani.test');
    await repos.users.upsertRole({
      id: 'role-bad',
      name: 'BROKEN',
      description: null,
      permissions: 'not json',
      created_at: at(0),
    });
    await repos.users.upsertUser(makeUser('u2', 'u2@urbani.test', { role_id: 'role-bad' }));
    const u1 = await repos.users.findById('u1');
    const u2 = await repos.users.findById('u2');
    expect(u1).not.toBeNull();
    expect(u2).not.toBeNull();
    expect(await repos.users.toAuthUser(u1!)).toEqual({
      id: 'u1',
      email: 'u1@urbani.test',
      displayName: 'User u1',
      role: 'ADMIN',
      permissions: ['*'],
    });
    expect(await repos.users.toAuthUser(u2!)).toEqual({
      id: 'u2',
      email: 'u2@urbani.test',
      displayName: 'User u2',
      role: 'BROKEN',
      permissions: [],
    });
    expect(await repos.users.toAuthUser({ ...u1!, role_id: 'role-missing' })).toEqual({
      id: 'u1',
      email: 'u1@urbani.test',
      displayName: 'User u1',
      role: 'UNKNOWN',
      permissions: [],
    });
  });

  it('C-UR-05 recordLogin sets last_login_at to the clock value; a missing id creates no user', async () => {
    await addUser('u1', 'u1@urbani.test');
    const { stamps: s } = await withStamps(() => repos.users.recordLogin('u1'));
    const u = await repos.users.findById('u1');
    expect(u?.last_login_at).not.toBeNull();
    expect(s).toContain(u?.last_login_at);
    await expect(repos.users.recordLogin('u-missing')).resolves.toBeUndefined();
    expect(await repos.users.findById('u-missing')).toBeNull();
  });

  it('C-UR-06 an email owned by another id rejects and the owner is unchanged', async () => {
    const u1 = await addUser('u1', 'a@urbani.test');
    const u2 = await addUser('u2', 'b@urbani.test');
    await expect(repos.users.upsertUser(makeUser('u2', 'a@urbani.test'))).rejects.toThrow();
    await expect(repos.users.upsertUser(makeUser('u3', 'a@urbani.test'))).rejects.toThrow();
    expect(await repos.users.findById('u1')).toEqual({ ...u1, role: 'SUPER_ADMIN' });
    expect((await repos.users.findByEmail('a@urbani.test'))?.id).toBe('u1');
    expect(await repos.users.findById('u2')).toEqual({ ...u2, role: 'SUPER_ADMIN' });
    expect(await repos.users.findById('u3')).toBeNull();
  });

  it('C-UR-07 changing the email frees the old one', async () => {
    const u1 = await addUser('u1', 'old@urbani.test');
    await repos.users.upsertUser({ ...u1, email: 'new@urbani.test' });
    expect(await repos.users.findByEmail('old@urbani.test')).toBeNull();
    expect((await repos.users.findByEmail('new@urbani.test'))?.id).toBe('u1');
    await repos.users.upsertUser(makeUser('u2', 'old@urbani.test'));
    expect((await repos.users.findByEmail('old@urbani.test'))?.id).toBe('u2');
  });

  it('C-UR-08 an upsert without role keeps the stored role; an invalid role is rejected', async () => {
    await addUser('u1', 'u1@urbani.test', { role: 'QA_OPERATOR' });
    await repos.users.upsertUser(makeUser('u1', 'u1@urbani.test', { display_name: 'Renamed' }));
    const u = await repos.users.findById('u1');
    expect(u?.role).toBe('QA_OPERATOR');
    expect(u?.display_name).toBe('Renamed');
    await expectReason(
      repos.users.upsertUser(makeUser('u1', 'u1@urbani.test', { role: 'BOGUS' as UserRole })),
      'INVALID_ARGUMENT',
    );
    expect((await repos.users.findById('u1'))?.role).toBe('QA_OPERATOR');
  });

  it('C-UR-09 re-upserting an existing user keeps its preferences and chat sessions', async () => {
    const u1 = await addUser('u1', 'u1@urbani.test');
    await repos.preferences.update('u1', { theme: 'dark' });
    const session = await repos.chat.createSession({ userId: 'u1', title: 'Kept' });
    await repos.users.upsertUser({ ...u1, display_name: 'Upserted again' });
    expect((await repos.preferences.get('u1'))?.theme).toBe('dark');
    expect(await repos.chat.getSession(session.id)).toEqual(session);
    expect((await repos.chat.listSessionsByUser('u1')).items.map((x) => x.id)).toEqual([session.id]);
  });

  it('C-UR-10 two concurrent email changes of one user leave exactly one new email', async () => {
    const u1 = await addUser('u1', 'o@urbani.test');
    const results = await Promise.allSettled([
      repos.users.upsertUser({ ...u1, email: 'a@urbani.test' }),
      repos.users.upsertUser({ ...u1, email: 'b@urbani.test' }),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await repos.users.findByEmail('o@urbani.test')).toBeNull();
    const a = await repos.users.findByEmail('a@urbani.test');
    const b = await repos.users.findByEmail('b@urbani.test');
    const owners = [a, b].filter((x) => x !== null);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.id).toBe('u1');
    expect((await repos.users.findById('u1'))?.email).toBe(owners[0]?.email);
    const other = owners[0]?.email === 'a@urbani.test' ? 'b@urbani.test' : 'a@urbani.test';
    await repos.users.upsertUser(makeUser('u2', other));
    expect((await repos.users.findByEmail(other))?.id).toBe('u2');
  });

  it('C-UR-12 getById and list include inactive users; list is ordered by email', async () => {
    await addUser('u1', 'b@urbani.test');
    await addUser('u2', 'a@urbani.test', { is_active: 0 });
    expect((await repos.users.getById('u2'))?.is_active).toBe(0);
    expect(await repos.users.getById('u-missing')).toBeNull();
    expect((await repos.users.list()).map((u) => u.email)).toEqual(['a@urbani.test', 'b@urbani.test']);
  });
  it('C-UR-11 two concurrent creates of one new id leave exactly one of the emails', async () => {
    await repos.users.upsertRole(ADMIN_ROLE);
    const results = await Promise.allSettled([
      repos.users.upsertUser(makeUser('u-new', 'a@urbani.test')),
      repos.users.upsertUser(makeUser('u-new', 'b@urbani.test')),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const a = await repos.users.findByEmail('a@urbani.test');
    const b = await repos.users.findByEmail('b@urbani.test');
    const owners = [a, b].filter((x) => x !== null);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.id).toBe('u-new');
    const other = owners[0]?.email === 'a@urbani.test' ? 'b@urbani.test' : 'a@urbani.test';
    await repos.users.upsertUser(makeUser('u2', other));
    expect((await repos.users.findByEmail(other))?.id).toBe('u2');
  });

  // ---------------------------------------------------------------- Preferences

  it('C-PF-01 preferences.get for an unknown user returns null', async () => {
    await addUser('u1', 'u1@urbani.test');
    expect(await repos.preferences.get('u1')).toBeNull();
    expect(await repos.preferences.get('nobody')).toBeNull();
  });

  it('C-PF-02 patching theme then layout keeps both; updatedAt is the clock value', async () => {
    await addUser('u1', 'u1@urbani.test');
    const first = await withStamps(() => repos.preferences.update('u1', { theme: 'dark' }));
    expect(first.value).toEqual({ userId: 'u1', theme: 'dark', widgetLayout: null, updatedAt: expect.any(String) });
    expect(first.stamps).toContain(first.value.updatedAt);
    expect((await repos.preferences.get('u1'))?.userId).toBe('u1');

    const second = await withStamps(() => repos.preferences.update('u1', { widgetLayout: { cols: 3 } }));
    expect(second.value).toEqual({ userId: 'u1', theme: 'dark', widgetLayout: { cols: 3 }, updatedAt: expect.any(String) });
    expect(second.stamps).toContain(second.value.updatedAt);
    expect(await repos.preferences.get('u1')).toEqual(second.value);
  });

  it('C-PF-03 null clears a field; nested JSON round-trips', async () => {
    await addUser('u1', 'u1@urbani.test');
    const layout = {
      rows: [{ id: 'w1', size: [2, 3], opts: { pinned: true, label: null } }],
      ratio: 1.5,
      title: 'ünïcödé 😀',
    };
    await repos.preferences.update('u1', { theme: 'light', widgetLayout: layout });
    expect((await repos.preferences.get('u1'))?.widgetLayout).toEqual(layout);
    await repos.preferences.update('u1', { theme: null });
    let p = await repos.preferences.get('u1');
    expect(p?.theme).toBeNull();
    expect(p?.widgetLayout).toEqual(layout);
    await repos.preferences.update('u1', { widgetLayout: null });
    p = await repos.preferences.get('u1');
    expect(p).toEqual({ userId: 'u1', theme: null, widgetLayout: null, updatedAt: expect.any(String) });
  });

  it('C-PF-04 invalid patches raise INVALID_ARGUMENT; an unknown user raises REFERENCE_NOT_FOUND', async () => {
    await addUser('u1', 'u1@urbani.test');
    await expectReason(repos.preferences.update('u1', { theme: 'blue' as Theme }), 'INVALID_ARGUMENT');
    await expectReason(repos.preferences.update('u1', { widgetLayout: 'x'.repeat(16_385) }), 'INVALID_ARGUMENT');
    await expectReason(repos.preferences.update('u1', { widgetLayout: { n: BigInt(1) } }), 'INVALID_ARGUMENT');
    await expectReason(repos.preferences.update('u1', {}), 'INVALID_ARGUMENT');
    await expectReason(repos.preferences.update('nobody', { theme: 'dark' }), 'REFERENCE_NOT_FOUND');
    expect(await repos.preferences.get('u1')).toBeNull();
    expect(await repos.preferences.get('nobody')).toBeNull();
  });

  it('C-PF-05 an inactive user can still create and update preferences', async () => {
    await addUser('u1', 'u1@urbani.test', { is_active: 0 });
    await repos.preferences.update('u1', { theme: 'dark' });
    await repos.preferences.update('u1', { widgetLayout: ['a'] });
    expect(await repos.preferences.get('u1')).toEqual({
      userId: 'u1',
      theme: 'dark',
      widgetLayout: ['a'],
      updatedAt: expect.any(String),
    });
  });

  // ---------------------------------------------------------------- Chat

  it('C-CH-01 createSession then getSession; unknown user and duplicate id are rejected', async () => {
    await addUser('u1', 'u1@urbani.test');
    const { value: s, stamps } = await withStamps(() =>
      repos.chat.createSession({ userId: 'u1', title: 'First', service: 'main', environment: 'qa' }),
    );
    expect(s).toEqual({
      id: expect.any(String),
      userId: 'u1',
      title: 'First',
      service: 'main',
      environment: 'qa',
      messageCount: 0,
      createdAt: s.createdAt,
      updatedAt: s.createdAt,
    });
    expect(stamps).toContain(s.createdAt);
    expect(await repos.chat.getSession(s.id)).toEqual(s);

    const bare = await repos.chat.createSession({ userId: 'u1' });
    expect(bare.id).not.toBe(s.id);
    expect([bare.title, bare.service, bare.environment]).toEqual([null, null, null]);

    await expectReason(repos.chat.createSession({ userId: 'nobody' }), 'REFERENCE_NOT_FOUND');
    const fixed = await repos.chat.createSession({ id: 'sess-1', userId: 'u1' });
    expect(fixed.id).toBe('sess-1');
    await expectReason(repos.chat.createSession({ id: 'sess-1', userId: 'u1', title: 'again' }), 'DUPLICATE');
    expect((await repos.chat.getSession('sess-1'))?.title).toBeNull();
    expect(await repos.chat.getSession('sess-missing')).toBeNull();
  });

  it('C-CH-02 appendMessage returns id and createdAt, increments messageCount and bumps updatedAt', async () => {
    await addUser('u1', 'u1@urbani.test');
    const s = await repos.chat.createSession({ userId: 'u1' });
    const { value: m, stamps } = await withStamps(() =>
      repos.chat.appendMessage({ sessionId: s.id, role: 'user', content: 'hello' }),
    );
    expect(m).toEqual({
      id: expect.any(String),
      sessionId: s.id,
      role: 'user',
      content: 'hello',
      citations: [],
      provider: null,
      modelId: null,
      source: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      createdAt: expect.any(String),
    });
    expect(stamps).toContain(m.createdAt);
    let after = await repos.chat.getSession(s.id);
    expect(after?.messageCount).toBe(1);
    expect(after?.updatedAt).toBe(m.createdAt);
    expect((after?.updatedAt ?? '') > s.updatedAt).toBe(true);
    expect(after?.createdAt).toBe(s.createdAt);

    const m2 = await repos.chat.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'hi there',
      citations: ['log line 1', 'log line 2'],
      provider: 'MockAIProvider',
      modelId: 'model-test',
      source: 'MOCK',
      latencyMs: 12,
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(m2.id).not.toBe(m.id);
    after = await repos.chat.getSession(s.id);
    expect(after?.messageCount).toBe(2);
    expect(after?.updatedAt).toBe(m2.createdAt);
    expect((await repos.chat.listMessages(s.id)).items).toEqual([m, m2]);
  });

  it('C-CH-03 listMessages returns messages oldest first, with cursor pages', async () => {
    await addUser('u1', 'u1@urbani.test');
    const s = await repos.chat.createSession({ userId: 'u1' });
    const appended: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      appended.push(await repos.chat.appendMessage({ sessionId: s.id, role: i % 2 ? 'assistant' : 'user', content: `msg ${i}` }));
    }
    const all = await repos.chat.listMessages(s.id);
    expect(all.items).toEqual(appended);
    expect(all.nextCursor).toBeNull();

    const { pages, cursors } = await collectPages((cursor) => repos.chat.listMessages(s.id, { limit: 2, cursor }));
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(cursors[2]).toBeNull();
    expect(pages.flat()).toEqual(appended);
  });

  it('C-CH-04 listSessionsByUser returns only that user, most recent first, with cursor pages', async () => {
    await addUser('u1', 'u1@urbani.test');
    await addUser('u2', 'u2@urbani.test');
    const sA = await repos.chat.createSession({ userId: 'u1', title: 'A' });
    const sB = await repos.chat.createSession({ userId: 'u1', title: 'B' });
    const sC = await repos.chat.createSession({ userId: 'u1', title: 'C' });
    const sOther = await repos.chat.createSession({ userId: 'u2', title: 'Other' });
    await repos.chat.appendMessage({ sessionId: sA.id, role: 'user', content: 'bump A' });

    const ids = (p: CursorPage<ChatSession>) => p.items.map((x) => x.id);
    const all = await repos.chat.listSessionsByUser('u1');
    expect(ids(all)).toEqual([sA.id, sC.id, sB.id]);
    expect(all.nextCursor).toBeNull();
    expect(all.items[0].messageCount).toBe(1);

    const { pages, cursors } = await collectPages((cursor) => repos.chat.listSessionsByUser('u1', { limit: 2, cursor }));
    expect(pages.map((p) => p.map((x) => x.id))).toEqual([[sA.id, sC.id], [sB.id]]);
    expect(cursors[1]).toBeNull();

    expect(ids(await repos.chat.listSessionsByUser('u2'))).toEqual([sOther.id]);
    expect((await repos.chat.listSessionsByUser('nobody')).items).toEqual([]);
  });

  it('C-CH-05 appendMessage rejects a missing session, a bad role and oversized content', async () => {
    await addUser('u1', 'u1@urbani.test');
    await expectReason(
      repos.chat.appendMessage({ sessionId: 'sess-missing', role: 'user', content: 'x' }),
      'REFERENCE_NOT_FOUND',
    );
    const s = await repos.chat.createSession({ userId: 'u1' });
    await expectReason(
      repos.chat.appendMessage({ sessionId: s.id, role: 'system' as ChatMessageRole, content: 'x' }),
      'INVALID_ARGUMENT',
    );
    await expectReason(
      repos.chat.appendMessage({ sessionId: s.id, role: 'user', content: 'x'.repeat(65_537) }),
      'INVALID_ARGUMENT',
    );
    expect((await repos.chat.listMessages(s.id)).items).toEqual([]);
    expect((await repos.chat.getSession(s.id))?.messageCount).toBe(0);
  });

  it('C-CH-06 setFeedback creates then updates: createdAt kept, updatedAt bumped, one per message', async () => {
    await addUser('u1', 'u1@urbani.test');
    const s = await repos.chat.createSession({ userId: 'u1' });
    const m = await repos.chat.appendMessage({ sessionId: s.id, role: 'assistant', content: 'answer' });
    const first = await withStamps(() =>
      repos.chat.setFeedback({ sessionId: s.id, messageId: m.id, userId: 'u1', rating: 'LIKE' }),
    );
    expect(first.value).toEqual({
      messageId: m.id,
      sessionId: s.id,
      userId: 'u1',
      rating: 'LIKE',
      comment: null,
      createdAt: expect.any(String),
      updatedAt: first.value.createdAt,
    });
    expect(first.stamps).toContain(first.value.createdAt);

    const second = await withStamps(() =>
      repos.chat.setFeedback({ sessionId: s.id, messageId: m.id, userId: 'u1', rating: 'DISLIKE', comment: 'wrong service' }),
    );
    expect(second.value).toEqual({
      messageId: m.id,
      sessionId: s.id,
      userId: 'u1',
      rating: 'DISLIKE',
      comment: 'wrong service',
      createdAt: first.value.createdAt,
      updatedAt: expect.any(String),
    });
    expect(second.stamps).toContain(second.value.updatedAt);
    expect(second.value.updatedAt > first.value.updatedAt).toBe(true);
    expect(await repos.chat.listFeedback(s.id)).toEqual([second.value]);
  });

  it('C-CH-07 feedback for a message outside the session raises REFERENCE_NOT_FOUND', async () => {
    await addUser('u1', 'u1@urbani.test');
    const s1 = await repos.chat.createSession({ userId: 'u1' });
    const s2 = await repos.chat.createSession({ userId: 'u1' });
    const m = await repos.chat.appendMessage({ sessionId: s1.id, role: 'assistant', content: 'answer' });
    await expectReason(
      repos.chat.setFeedback({ sessionId: s2.id, messageId: m.id, userId: 'u1', rating: 'LIKE' }),
      'REFERENCE_NOT_FOUND',
    );
    await expectReason(
      repos.chat.setFeedback({ sessionId: s1.id, messageId: 'msg-missing', userId: 'u1', rating: 'LIKE' }),
      'REFERENCE_NOT_FOUND',
    );
    expect(await repos.chat.listFeedback(s1.id)).toEqual([]);
    expect(await repos.chat.listFeedback(s2.id)).toEqual([]);
  });

  it('C-CH-08 listFeedback sorts by message id', async () => {
    await addUser('u1', 'u1@urbani.test');
    const s = await repos.chat.createSession({ userId: 'u1' });
    const ms: ChatMessage[] = [];
    for (let i = 0; i < 3; i++) ms.push(await repos.chat.appendMessage({ sessionId: s.id, role: 'assistant', content: `a${i}` }));
    for (const m of [ms[2], ms[0], ms[1]]) {
      await repos.chat.setFeedback({ sessionId: s.id, messageId: m.id, userId: 'u1', rating: 'LIKE' });
    }
    const ids = (await repos.chat.listFeedback(s.id)).map((f) => f.messageId);
    expect(ids).toEqual(sorted(ms.map((m) => m.id)));
    expect(ids).toEqual(ms.map((m) => m.id));
  });

  it('C-CH-09 setFeedback rejects an unknown userId and accepts an inactive user', async () => {
    await addUser('u1', 'u1@urbani.test');
    await addUser('u2', 'u2@urbani.test', { is_active: 0 });
    const s = await repos.chat.createSession({ userId: 'u1' });
    const m = await repos.chat.appendMessage({ sessionId: s.id, role: 'assistant', content: 'answer' });
    await expectReason(
      repos.chat.setFeedback({ sessionId: s.id, messageId: m.id, userId: 'nobody', rating: 'LIKE' }),
      'REFERENCE_NOT_FOUND',
    );
    const f = await repos.chat.setFeedback({ sessionId: s.id, messageId: m.id, userId: 'u2', rating: 'DISLIKE' });
    expect(f.userId).toBe('u2');
    expect((await repos.chat.listFeedback(s.id)).map((x) => x.userId)).toEqual(['u2']);
  });

  it('C-CH-10 read methods reject an empty or a 129-character id with INVALID_ARGUMENT', async () => {
    for (const id of ['', 'x'.repeat(129)]) {
      await expectReason(repos.chat.getSession(id), 'INVALID_ARGUMENT');
      await expectReason(repos.chat.listSessionsByUser(id), 'INVALID_ARGUMENT');
      await expectReason(repos.chat.listMessages(id), 'INVALID_ARGUMENT');
      await expectReason(repos.chat.listFeedback(id), 'INVALID_ARGUMENT');
      await expectReason(repos.preferences.get(id), 'INVALID_ARGUMENT');
    }
  });

  // ---------------------------------------------------------------- Keys

  it('C-KY-01 over-long and empty keys behave as not found', async () => {
    await addUser('u1', 'u1@urbani.test');
    await repos.alerts.insert(makeAlert('ALT-1'));
    await repos.audit.record('alice@urbani.test', 'LOGIN');
    const longEmail = `${'e'.repeat(1993)}@x.test`;
    expect(longEmail).toHaveLength(2000);
    for (const key of ['k'.repeat(2000), '']) {
      expect(await repos.alerts.findById(key)).toBeNull();
      expect(await repos.alerts.acknowledge(key, 'alice@urbani.test')).toBeNull();
      expect(await repos.services.findById(key)).toBeNull();
      expect(await repos.aiAnalyses.findById(key)).toBeNull();
      expect(await repos.users.findById(key)).toBeNull();
      expect(await repos.logs.byAlert(key)).toEqual([]);
      await expect(repos.users.recordLogin(key)).resolves.toBeUndefined();
    }
    expect(await repos.users.findByEmail(longEmail)).toBeNull();
    expect(await repos.users.findByEmail('')).toBeNull();
    expect((await repos.audit.query({ actor: 'a'.repeat(2100) })).total).toBe(0);
    expect(await repos.alerts.countAll()).toBe(1);
  });

  // ---------------------------------------------------------------- Health

  it('C-HL-01 health.ping resolves', async () => {
    await expect(repos.health.ping()).resolves.toBeUndefined();
  });
}
