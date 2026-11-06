import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AUDIT_ACTIONS, AUDIT_ACTION_CATALOG, type AuditAction, type UserRole } from '@urbani/shared';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { authService } from '../services/authService';
import { auditService } from '../services/auditService';

/** Audit log (DPI 2 item 3): coverage, redaction, filters, pagination, access, append-only, retention. */
const PASSWORD = 'Str0ng-Passw0rd!';
const app = createApp();
let db: ReturnType<typeof freshTestDb>;
const tokens = {} as Record<string, string>;
const ids = {} as Record<string, string>;
let alertId = '';

const call = (method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string, token?: string, body?: object) => {
  const r = request(app)[method](path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const events = async (action: AuditAction) =>
  (await getRepositories().audit.listByTimeRange({ actions: [action], limit: 200 })).items;
/** Runs fn and returns the new events of `action` it produced. */
async function produced(action: AuditAction, fn: () => Promise<unknown>) {
  const before = (await events(action)).length;
  await fn();
  const after = await events(action);
  expect(after.length, `${action} should be audited exactly once`).toBe(before + 1);
  return after[0];
}

beforeAll(async () => {
  db = freshTestDb();
  await seed();
  const admin = await authService.login(config.auth.seedAdminEmail, config.auth.seedAdminPassword);
  tokens.SUPER_ADMIN = admin.token;
  ids.SUPER_ADMIN = admin.user.id;
  for (const role of ['QA_OPERATOR', 'READER_AUDITOR'] as UserRole[]) {
    const res = await call('post', '/api/users', tokens.SUPER_ADMIN, {
      email: `${role.toLowerCase()}@urbani.test`,
      displayName: role,
      role,
      password: PASSWORD,
    });
    ids[role] = res.body.data.id;
    tokens[role] = (await authService.login(`${role.toLowerCase()}@urbani.test`, PASSWORD)).token;
  }
  alertId = (await call('get', '/api/alerts', tokens.SUPER_ADMIN)).body.data.items[0].alertId;
});
afterAll(() => db.close());

describe('audit catalog', () => {
  it('classifies every audited action as CONFIG or SENSITIVE_QUERY', () => {
    for (const a of AUDIT_ACTIONS) expect(['CONFIG', 'SENSITIVE_QUERY']).toContain(AUDIT_ACTION_CATALOG[a].category);
  });
  it('GET /api/audit/actions lists every action with its category', async () => {
    const res = await call('get', '/api/audit/actions', tokens.READER_AUDITOR);
    expect(res.status).toBe(200);
    expect(res.body.data.actions).toHaveLength(AUDIT_ACTIONS.length);
    expect(res.body.data.categories).toEqual(['CONFIG', 'SENSITIVE_QUERY']);
  });
});

describe('audit coverage: exactly one event per audited request', () => {
  it('login success and failure', async () => {
    const ok = await produced('LOGIN', () =>
      call('post', '/api/auth/login', undefined, { email: 'qa_operator@urbani.test', password: PASSWORD }),
    );
    expect(ok.actor).toBe('qa_operator@urbani.test');
    expect(ok.result).toBe('SUCCESS');
    const bad = await produced('auth.login_failed', () =>
      call('post', '/api/auth/login', undefined, { email: 'qa_operator@urbani.test', password: 'Wrong-Password-1' }),
    );
    expect(bad.result).toBe('FAILURE');
  });

  it('logout', async () => {
    await produced('LOGOUT', () => call('post', '/api/auth/logout', tokens.QA_OPERATOR));
  });

  it('alert acknowledge carries user id, email, role, ip and request id', async () => {
    const e = await produced('ALERT_ACKNOWLEDGED', () =>
      call('post', `/api/alerts/${encodeURIComponent(alertId)}/acknowledge`, tokens.QA_OPERATOR),
    );
    expect(e.actor).toBe('qa_operator@urbani.test');
    expect(e.target).toBe(alertId);
    expect(e.result).toBe('SUCCESS');
    expect(e.timestamp).toMatch(/Z$/);
    const ctx = (e.metadata as { ctx: Record<string, string> }).ctx;
    expect(ctx).toMatchObject({ userId: ids.QA_OPERATOR, email: 'qa_operator@urbani.test', role: 'QA_OPERATOR' });
    expect(ctx.requestId).toBeTruthy();
    expect(ctx.ip).toBeTruthy();
  });

  it('alert view', async () => {
    await produced('ALERT_VIEWED', () => call('get', `/api/alerts/${encodeURIComponent(alertId)}`, tokens.READER_AUDITOR));
  });

  it('settings update records key names only', async () => {
    const e = await produced('CONFIG_CHANGED', () =>
      call('put', '/api/settings', tokens.SUPER_ADMIN, { password: 'hunter2-secret', theme: 'x' }),
    );
    expect(JSON.stringify(e)).not.toContain('hunter2-secret');
    expect(e.metadata).toMatchObject({ requestedKeys: ['password', 'theme'] });
  });

  it('AI analyze', async () => {
    const e = await produced('ai.analyze', () =>
      call('post', '/api/ai/analyze', tokens.QA_OPERATOR, { service: 'main', environment: 'qa' }),
    );
    expect(e.metadata).toMatchObject({ service: 'main', environment: 'qa' });
  });

  it('chat question: preview only, never the answer', async () => {
    const question = `Why is main failing? ${'x'.repeat(300)}`;
    let answer = '';
    const e = await produced('chat.query', async () => {
      const res = await call('post', '/api/chat', tokens.QA_OPERATOR, { question, service: 'main', environment: 'qa' });
      expect(res.status).toBe(200);
      answer = res.body.data.answer;
    });
    const meta = e.metadata as { questionPreview: string; questionChars: number };
    expect(meta.questionPreview.length).toBeLessThanOrEqual(81);
    expect(meta.questionChars).toBe(question.length);
    expect(answer.length).toBeGreaterThan(20);
    expect(JSON.stringify(e)).not.toContain(answer);
  });

  it('log search records filter parameters, not content', async () => {
    const e = await produced('logs.search', () => call('get', '/api/logs?level=ERROR&search=timeout', tokens.READER_AUDITOR));
    expect(e.metadata).toMatchObject({ level: 'ERROR', search: 'timeout' });
    expect(JSON.stringify(e.metadata)).not.toContain('message');
  });

  it('user create, role change, deactivate, activate, password reset', async () => {
    let newId = '';
    await produced('user.create', async () => {
      const res = await call('post', '/api/users', tokens.SUPER_ADMIN, {
        email: 'audit.target@urbani.test',
        displayName: 'Audit Target',
        role: 'READER_AUDITOR',
        password: PASSWORD,
      });
      newId = res.body.data.id;
    });
    await produced('user.role_change', () => call('put', `/api/users/${newId}/role`, tokens.SUPER_ADMIN, { role: 'QA_OPERATOR' }));
    await produced('user.deactivate', () => call('post', `/api/users/${newId}/deactivate`, tokens.SUPER_ADMIN));
    await produced('user.activate', () => call('post', `/api/users/${newId}/activate`, tokens.SUPER_ADMIN));
    const reset = await produced('user.password_reset', () =>
      call('post', `/api/users/${newId}/reset-password`, tokens.SUPER_ADMIN, { password: 'Another-Passw0rd!' }),
    );
    expect(JSON.stringify(reset)).not.toContain('Another-Passw0rd!');
  });

  it('access.denied has result DENIED', async () => {
    const e = await produced('access.denied', () => call('get', '/api/audit', tokens.QA_OPERATOR));
    expect(e.result).toBe('DENIED');
  });

  it('viewing the audit log is itself audited once per request', async () => {
    const e = await produced('audit.view', () => call('get', '/api/audit?limit=5&result=SUCCESS', tokens.READER_AUDITOR));
    expect(e.actor).toBe('reader_auditor@urbani.test');
    expect(e.metadata).toMatchObject({ limit: 5, result: 'SUCCESS' });
  });
});

describe('redaction in stored events', () => {
  it('never stores passwords, tokens or api keys', async () => {
    await getRepositories().audit.record('x@urbani.test', 'CONFIG_CHANGED', 'settings', {
      password: 'pw-123',
      nested: { token: 'tok-456', apiKey: 'key-789' },
    });
    const dump = JSON.stringify((await getRepositories().audit.listByTimeRange({ limit: 200 })).items);
    for (const secret of ['pw-123', 'tok-456', 'key-789', PASSWORD, 'Another-Passw0rd!', 'hunter2-secret', 'Wrong-Password-1']) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).toContain('[REDACTED]');
  });
});

describe('GET /api/audit: access', () => {
  it('QA_OPERATOR gets 403, READER_AUDITOR and SUPER_ADMIN get 200, anonymous 401', async () => {
    expect((await call('get', '/api/audit', tokens.QA_OPERATOR)).status).toBe(403);
    expect((await call('get', '/api/audit/actions', tokens.QA_OPERATOR)).status).toBe(403);
    expect((await call('get', '/api/audit', tokens.READER_AUDITOR)).status).toBe(200);
    expect((await call('get', '/api/audit', tokens.SUPER_ADMIN)).status).toBe(200);
    expect((await call('get', '/api/audit')).status).toBe(401);
  });

  it('is append-only over HTTP: no update or delete route exists', async () => {
    const some = (await call('get', '/api/audit?limit=1', tokens.SUPER_ADMIN)).body.data.items[0];
    for (const method of ['delete', 'put', 'patch', 'post'] as const) {
      for (const path of ['/api/audit', `/api/audit/${some.id}`]) {
        const res = await call(method, path, tokens.SUPER_ADMIN, {});
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    const still = await call('get', '/api/audit?limit=200', tokens.SUPER_ADMIN);
    expect(still.body.data.items.some((e: { id: string }) => e.id === some.id)).toBe(true);
  });

  it('READER_AUDITOR cannot mutate anything', async () => {
    expect((await call('post', `/api/alerts/${encodeURIComponent(alertId)}/acknowledge`, tokens.READER_AUDITOR)).status).toBe(403);
    expect((await call('put', '/api/settings', tokens.READER_AUDITOR, {})).status).toBe(403);
  });
});

describe('GET /api/audit: filters and pagination', () => {
  const list = async (qs: string) => (await call('get', `/api/audit?${qs}`, tokens.SUPER_ADMIN)).body.data;

  it('filters by result, category, action, actor, user id and text', async () => {
    const denied = await list('result=DENIED&limit=200');
    expect(denied.items.length).toBeGreaterThan(0);
    expect(denied.items.every((e: { result: string }) => e.result === 'DENIED')).toBe(true);

    const cfg = await list('category=CONFIG&limit=200');
    expect(cfg.items.length).toBeGreaterThan(0);
    expect(cfg.items.every((e: { action: AuditAction }) => AUDIT_ACTION_CATALOG[e.action].category === 'CONFIG')).toBe(true);
    const sens = await list('category=SENSITIVE_QUERY&limit=200');
    expect(sens.items.every((e: { action: AuditAction }) => AUDIT_ACTION_CATALOG[e.action].category === 'SENSITIVE_QUERY')).toBe(true);

    const one = await list('action=ALERT_ACKNOWLEDGED&limit=200');
    expect(one.items).toHaveLength(1);
    expect(one.items[0].action).toBe('ALERT_ACKNOWLEDGED');
    expect((await list('category=SENSITIVE_QUERY&action=ALERT_ACKNOWLEDGED&limit=200')).items).toHaveLength(0);

    const byActor = await list('actor=qa_operator@urbani.test&limit=200');
    expect(byActor.items.length).toBeGreaterThan(0);
    expect(byActor.items.every((e: { actor: string }) => e.actor === 'qa_operator@urbani.test')).toBe(true);

    const byUser = await list(`userId=${ids.QA_OPERATOR}&limit=200`);
    expect(byUser.items.length).toBeGreaterThan(0);
    expect(byUser.items.every((e: { metadata: { ctx: { userId: string } } }) => e.metadata.ctx.userId === ids.QA_OPERATOR)).toBe(true);

    const byText = await list('text=TIMEOUT&limit=200');
    expect(byText.items.map((e: { action: string }) => e.action)).toEqual(['logs.search']);
  });

  it('filters by date range and rejects a bad range', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await list(`from=${encodeURIComponent(future)}`)).items).toHaveLength(0);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect((await list(`from=${encodeURIComponent(past)}&limit=1`)).items).toHaveLength(1);
    const bad = await call('get', `/api/audit?from=${encodeURIComponent(future)}&to=${encodeURIComponent(past)}`, tokens.SUPER_ADMIN);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await call('get', '/api/audit?result=NOPE', tokens.SUPER_ADMIN)).status).toBe(400);
  });

  it('pages newest first with a cursor and no duplicates', async () => {
    const seen: { id: string; timestamp: string }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const data: { items: { id: string; timestamp: string }[]; nextCursor: string | null } = await list(
        `limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(data.items.length).toBeLessThanOrEqual(7);
      seen.push(...data.items);
      cursor = data.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    expect(pages).toBeGreaterThan(2);
    expect(new Set(seen.map((e) => e.id)).size).toBe(seen.length);
    const stamps = seen.map((e) => e.timestamp);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it('keeps the legacy page/pageSize response shape', async () => {
    const res = await call('get', '/api/audit?page=1&pageSize=3&action=LOGIN', tokens.SUPER_ADMIN);
    expect(res.body.data).toMatchObject({ page: 1, pageSize: 3 });
    expect(typeof res.body.data.total).toBe('number');
  });
});

describe('retention', () => {
  it('purges only events older than the window and writes one summary event', async () => {
    const insert = db.prepare(
      'INSERT INTO audit_events (id, timestamp, actor, action, target, metadata, created_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const older = new Date(Date.now() - 500 * 86_400_000).toISOString();
    insert.run('old-1', old, 'old@urbani.test', 'LOGIN', null, null, old, 'SUCCESS');
    insert.run('old-2', older, 'old@urbani.test', 'LOGIN', null, null, older, 'SUCCESS');
    const before = (await getRepositories().audit.query({ pageSize: 200 })).total;

    const purged = await auditService.purgeExpired(new Date(), 365);
    expect(purged).toBe(2);
    const after = await getRepositories().audit.query({ pageSize: 200 });
    expect(after.items.some((e) => e.id === 'old-1' || e.id === 'old-2')).toBe(false);
    expect(after.total).toBe(before - 2 + 1);
    const summary = await events('audit.purge');
    expect(summary).toHaveLength(1);
    expect(summary[0].metadata).toMatchObject({ purged: 2, retentionDays: 365 });
  });

  it('retention 0 keeps everything and writes nothing', async () => {
    const before = (await events('audit.purge')).length;
    expect(await auditService.purgeExpired(new Date(), 0)).toBeNull();
    expect((await events('audit.purge')).length).toBe(before);
  });
});
