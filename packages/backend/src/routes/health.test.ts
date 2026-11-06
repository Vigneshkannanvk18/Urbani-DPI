import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { USER_ROLES, type HealthStatusResponse, type UserRole } from '@urbani/shared';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { authService } from '../services/authService';
import { healthService } from '../services/healthService';

/** Service health API + preferences API (DPI 2 items 9 and 10). */
const PASSWORD = 'Str0ng-Passw0rd!';
const app = createApp();
let db: ReturnType<typeof freshTestDb>;
const tokens = {} as Record<UserRole, string>;
const mutableHealth = config.health as unknown as { targetsRaw: string | null };

const call = (method: 'get' | 'post' | 'put', path: string, token?: string, body?: object) => {
  const r = request(app)[method](path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const auditOf = async (action: string) => (await getRepositories().audit.listByTimeRange({ actions: [action], limit: 50 })).items;
const statusOf = async (): Promise<HealthStatusResponse> => (await call('get', '/api/health/status', tokens.SUPER_ADMIN)).body.data;
const NOW_MINUS = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeAll(async () => {
  db = freshTestDb();
  await seed();
  tokens.SUPER_ADMIN = (await authService.login(config.auth.seedAdminEmail, config.auth.seedAdminPassword)).token;
  for (const role of USER_ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
    await call('post', '/api/users', tokens.SUPER_ADMIN, { email: `${role.toLowerCase()}@urbani.test`, displayName: role, role, password: PASSWORD });
    tokens[role] = (await authService.login(`${role.toLowerCase()}@urbani.test`, PASSWORD)).token;
  }
});
afterAll(() => db.close());
afterEach(() => {
  mutableHealth.targetsRaw = null;
  process.env.RATE_LIMIT_DISABLED = '1';
});

describe('GET /api/health/status', () => {
  it('requires authentication', async () => {
    expect((await call('get', '/api/health/status')).status).toBe(401);
    expect((await call('get', '/api/health/history?target=radar-api')).status).toBe(401);
  });

  it.each(USER_ROLES)('%s can read status and history (services:view)', async (role) => {
    expect((await call('get', '/api/health/status', tokens[role])).status).toBe(200);
    expect((await call('get', '/api/health/history?target=radar-api', tokens[role])).status).toBe(200);
  });

  it('QA, Main and Payment without a URL are WAITING_FOR_INTEGRATION, never UP or LIVE', async () => {
    const s = await statusOf();
    for (const id of ['qa', 'main', 'payment']) {
      const t = s.targets.find((x) => x.id === id)!;
      expect(t.status).toBe('WAITING_FOR_INTEGRATION');
      expect(t.dataSource).toBe('WAITING_FOR_INTEGRATION');
      expect(t.note).toBe('No health endpoint configured -- needs Urbani input');
      expect(t.configHint).toContain('HEALTH_TARGETS');
      expect(t.lastCheckedAt).toBeNull();
      expect(t.uptime['24h'].uptimePct).toBeNull();
    }
    // The Urbani observability API is not configured in tests: waiting too, and labelled for what it measures.
    const urbani = s.targets.find((x) => x.id === 'urbani-qa-telemetry-api')!;
    expect(urbani).toMatchObject({ name: 'Urbani QA telemetry API', status: 'WAITING_FOR_INTEGRATION', dataSource: 'WAITING_FOR_INTEGRATION' });
    expect(urbani.configHint).toContain('URBANI_API_BASE_URL');
    expect(s.probesEnabled).toBe(false); // probes never run in tests
  });

  it('a configured target with no result yet is UNKNOWN (not UP, not LIVE)', async () => {
    mutableHealth.targetsRaw = JSON.stringify([{ id: 'qa', type: 'http', url: 'https://qa.example.com/health' }]);
    const qa = (await statusOf()).targets.find((t) => t.id === 'qa')!;
    expect(qa).toMatchObject({ status: 'UNKNOWN', dataSource: 'WAITING_FOR_INTEGRATION' });
    expect(qa.configHint).toBeNull();
  });

  it('computes uptime windows with sample counts and the insufficient-data rule from stored results', async () => {
    const repos = getRepositories();
    mutableHealth.targetsRaw = JSON.stringify([{ id: 'qa', type: 'http', url: 'https://qa.example.com/health' }]);
    // 12 samples in the last 45 minutes (the newest one minute ago): 9 UP, 2 DEGRADED, 1 DOWN. Two older samples (3 days ago) count for 7d / 30d only.
    for (let i = 0; i < 12; i++) {
      const status = i === 0 ? 'DOWN' : i <= 2 ? 'DEGRADED' : 'UP';
      await repos.health.recordResult({ targetId: 'qa', timestamp: NOW_MINUS((11 - i) * 4 + 1), status, httpStatus: status === 'DOWN' ? null : 200, latencyMs: 20 + i, error: status === 'DOWN' ? 'timeout after 5000 ms' : null });
    }
    for (const d of [3, 3.1]) {
      await repos.health.recordResult({ targetId: 'qa', timestamp: NOW_MINUS(d * 1440), status: 'UP', httpStatus: 200, latencyMs: 10, error: null });
    }
    const qa = (await statusOf()).targets.find((t) => t.id === 'qa')!;
    expect(qa).toMatchObject({ status: 'UP', dataSource: 'LIVE', httpStatus: 200 });
    expect(qa.uptime['24h']).toEqual({ uptimePct: 75, samples: 12, insufficientData: false });
    expect(qa.uptime['7d']).toEqual({ uptimePct: 78.57, samples: 14, insufficientData: false });
    expect(qa.uptime['30d'].samples).toBe(14);
    expect(qa.series.length).toBe(12);
    // A target with 3 samples only shows "insufficient data".
    mutableHealth.targetsRaw = JSON.stringify([{ id: 'main', type: 'http', url: 'https://main.example.com/health' }]);
    for (let i = 0; i < 3; i++) await repos.health.recordResult({ targetId: 'main', timestamp: NOW_MINUS(10 - i), status: 'UP', httpStatus: 200, latencyMs: 5, error: null });
    const main = (await statusOf()).targets.find((t) => t.id === 'main')!;
    expect(main.uptime['24h']).toEqual({ uptimePct: null, samples: 3, insufficientData: true });
  });

  it('a stale latest result is UNKNOWN, not LIVE', async () => {
    mutableHealth.targetsRaw = JSON.stringify([{ id: 'payment', type: 'http', url: 'https://pay.example.com/health' }]);
    await getRepositories().health.recordResult({ targetId: 'payment', timestamp: NOW_MINUS(60), status: 'UP', httpStatus: 200, latencyMs: 5, error: null });
    const t = (await statusOf()).targets.find((x) => x.id === 'payment')!;
    expect(t).toMatchObject({ status: 'UNKNOWN', dataSource: 'WAITING_FOR_INTEGRATION' });
    expect(t.note).toMatch(/stale/);
  });

  it('shows open alert counts only where the target maps to a configured Urbani service', async () => {
    mutableHealth.targetsRaw = JSON.stringify([
      { id: 'main', type: 'http', url: 'https://main.example.com/health' },
      { id: 'payment', type: 'http', url: 'https://pay.example.com/health' },
    ]);
    const s = await statusOf();
    const main = s.targets.find((t) => t.id === 'main')!;
    expect(config.urbani.services).toContain('main');
    const open = await getRepositories().alerts.query({ service: 'main', status: 'OPEN', pageSize: 1 });
    expect(main.openAlerts).not.toBeNull();
    expect(Object.values(main.openAlerts!).reduce((a, b) => a + b, 0)).toBe(open.total);
    expect(s.targets.find((t) => t.id === 'payment')!.openAlerts).toBeNull(); // 'payment' is not a configured service id
    expect(s.targets.find((t) => t.id === 'radar-api')!.openAlerts).toBeNull();
  });

  it('reports invalid HEALTH_TARGETS entries without echoing URLs', async () => {
    mutableHealth.targetsRaw = JSON.stringify([{ id: 'qa', type: 'http', url: 'ftp://hunter2-host/x' }]);
    const s = await statusOf();
    expect(s.configErrors).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain('hunter2');
    expect(s.targets.find((t) => t.id === 'qa')!.status).toBe('WAITING_FOR_INTEGRATION');
  });
});

describe('GET /api/health/history', () => {
  it('returns points for a probed target, empty for a placeholder, 404 for an unknown target, 400 for a bad range', async () => {
    const repos = getRepositories();
    for (let i = 0; i < 5; i++) await repos.health.recordResult({ targetId: 'radar-api', timestamp: NOW_MINUS(30 - i), status: 'UP', httpStatus: null, latencyMs: 3, error: null });
    const ok = await call('get', '/api/health/history?target=radar-api&range=24h', tokens.READER_AUDITOR);
    expect(ok.body.data).toMatchObject({ target: 'radar-api', range: '24h' });
    expect(ok.body.data.points).toHaveLength(5);
    expect((await call('get', '/api/health/history?target=radar-api&range=30d', tokens.READER_AUDITOR)).body.data.points).toHaveLength(5);
    expect((await call('get', '/api/health/history?target=qa', tokens.SUPER_ADMIN)).body.data.points).toEqual([]);
    expect((await call('get', '/api/health/history?target=nope', tokens.SUPER_ADMIN)).status).toBe(404);
    expect((await call('get', '/api/health/history?target=radar-api&range=1y', tokens.SUPER_ADMIN)).status).toBe(400);
    expect((await call('get', '/api/health/history', tokens.SUPER_ADMIN)).status).toBe(400);
  });
});

describe('POST /api/health/check-now', () => {
  it('requires authentication', async () => {
    expect((await call('post', '/api/health/check-now')).status).toBe(401);
  });

  it.each([
    ['SUPER_ADMIN', 200],
    ['INFRA_ADMIN', 200],
    ['QA_OPERATOR', 403],
    ['READER_AUDITOR', 403],
  ] as const)('%s -> %i', async (role, expected) => {
    const res = await call('post', '/api/health/check-now', tokens[role]);
    expect(res.status).toBe(expected);
    if (expected === 403) expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('probes the Radar API for real, stores the result and audits the action (counts only)', async () => {
    const before = (await auditOf('health.check_now')).length;
    const res = await call('post', '/api/health/check-now', tokens.SUPER_ADMIN);
    expect(res.status).toBe(200);
    const radar = (res.body.data as HealthStatusResponse).targets.find((t) => t.id === 'radar-api')!;
    expect(radar).toMatchObject({ status: 'UP', dataSource: 'LIVE', httpStatus: null });
    expect(radar.latencyMs).toEqual(expect.any(Number));
    expect(radar.lastCheckedAt).toEqual(expect.any(String));
    expect(radar.uptime['24h'].insufficientData).toBe(true); // 1 sample is not "100% uptime"
    const events = await auditOf('health.check_now');
    expect(events.length).toBe(before + 1);
    expect(events[0]).toMatchObject({ target: 'health', result: 'SUCCESS' });
    expect(events[0].metadata).toMatchObject({ checked: expect.any(Number), statuses: expect.any(Object) });
    // placeholders were not probed and are still waiting after a check
    expect(res.body.data.targets.find((t: { id: string }) => t.id === 'qa').status).toBe('WAITING_FOR_INTEGRATION');
  });

  it('a forbidden call is not audited as a check and is recorded as access.denied', async () => {
    const before = (await auditOf('health.check_now')).length;
    await call('post', '/api/health/check-now', tokens.QA_OPERATOR);
    expect((await auditOf('health.check_now')).length).toBe(before);
    expect((await auditOf('access.denied')).some((e) => e.target === 'POST /api/health/check-now')).toBe(true);
  });

  it('is rate limited (429 after 5 calls per minute)', async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await call('post', '/api/health/check-now', tokens.SUPER_ADMIN)).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});

describe('health retention', () => {
  it('purges results older than the retention window and keeps newer ones; 0 days keeps everything', async () => {
    const repos = getRepositories();
    const day = 86_400_000;
    const now = new Date('2026-12-01T12:00:00.000Z');
    await repos.health.recordResult({ targetId: 'ret', timestamp: new Date(now.getTime() - 40 * day).toISOString(), status: 'UP', httpStatus: 200, latencyMs: 1, error: null });
    await repos.health.recordResult({ targetId: 'ret', timestamp: new Date(now.getTime() - 5 * day).toISOString(), status: 'UP', httpStatus: 200, latencyMs: 1, error: null });
    expect(await healthService.purgeExpired(now, 0)).toBeNull();
    expect(await healthService.purgeExpired(now, 30)).toBe(1);
    expect(await repos.health.listResults('ret', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')).toHaveLength(1);
  });
});

describe('/api/preferences (own preferences, any authenticated user)', () => {
  it('requires authentication', async () => {
    expect((await call('get', '/api/preferences')).status).toBe(401);
    expect((await call('put', '/api/preferences', undefined, { theme: 'dark' })).status).toBe(401);
  });

  it.each(USER_ROLES)('%s: defaults to system, saves, reads back, and can go back to system', async (role) => {
    const t = tokens[role];
    expect((await call('get', '/api/preferences', t)).body.data).toMatchObject({ theme: 'system', widgetLayout: null });
    expect((await call('put', '/api/preferences', t, { theme: 'dark' })).body.data.theme).toBe('dark');
    expect((await call('get', '/api/preferences', t)).body.data.theme).toBe('dark');
    expect((await call('put', '/api/preferences', t, { theme: 'light' })).body.data.theme).toBe('light');
    expect((await call('put', '/api/preferences', t, { theme: 'system' })).body.data.theme).toBe('system');
    expect((await call('get', '/api/preferences', t)).body.data.theme).toBe('system');
  });

  it('is strictly per user: one user cannot read or change another one', async () => {
    await call('put', '/api/preferences', tokens.QA_OPERATOR, { theme: 'dark' });
    expect((await call('get', '/api/preferences', tokens.READER_AUDITOR)).body.data.theme).toBe('system');
    // No user id is accepted anywhere: it is rejected as an unknown key.
    const res = await call('put', '/api/preferences', tokens.READER_AUDITOR, { theme: 'light', userId: 'someone-else' });
    expect(res.status).toBe(400);
    expect((await call('get', '/api/preferences', tokens.QA_OPERATOR)).body.data.theme).toBe('dark');
  });

  it('rejects unknown keys, invalid values and empty bodies (400) without changing anything', async () => {
    const t = tokens.INFRA_ADMIN;
    await call('put', '/api/preferences', t, { theme: 'light' });
    for (const body of [{ colour: 'red' }, { theme: 'purple' }, { theme: null }, { theme: 'dark', extra: 1 }, {}, { widgetLayout: 'x' }]) {
      const res = await call('put', '/api/preferences', t, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await call('get', '/api/preferences', t)).body.data.theme).toBe('light');
  });

  it('keeps room for widgetLayout: a bounded JSON object round-trips, an oversized one is rejected', async () => {
    const t = tokens.SUPER_ADMIN;
    const layout = { order: ['alerts', 'logs'], hidden: [] };
    expect((await call('put', '/api/preferences', t, { widgetLayout: layout })).body.data).toMatchObject({ widgetLayout: layout });
    expect((await call('get', '/api/preferences', t)).body.data.widgetLayout).toEqual(layout);
    expect((await call('put', '/api/preferences', t, { widgetLayout: { blob: 'x'.repeat(9000) } })).status).toBe(400);
    expect((await call('put', '/api/preferences', t, { widgetLayout: null })).body.data.widgetLayout).toBeNull();
  });
});
