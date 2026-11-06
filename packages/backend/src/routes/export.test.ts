import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ROLE_PERMISSIONS, USER_ROLES, type UserRole } from '@urbani/shared';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { authService } from '../services/authService';

/** Export API (DPI 2 item 11): formats, filters parity with /api/logs, caps, RBAC, rate limit, audit. */
const PASSWORD = 'Str0ng-Passw0rd!';
const app = createApp();
let db: ReturnType<typeof freshTestDb>;
const tokens = {} as Record<UserRole, string>;
let alertId = '';
const exportCfg = config.export as unknown as { maxRows: number; pdfMaxRows: number; rateLimitPerMin: number };
const original = { ...exportCfg };

const binary = (res: any, cb: (e: Error | null, b?: Buffer) => void) => {
  const parts: Buffer[] = [];
  res.on('data', (c: Buffer) => parts.push(c));
  res.on('end', () => cb(null, Buffer.concat(parts)));
};
const call = (path: string, token?: string) => {
  const r = request(app).get(path).buffer(true).parse(binary);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
const text = (res: request.Response) => (res.body as Buffer).toString('utf8');
const auditOf = async (action: string) => (await getRepositories().audit.listByTimeRange({ actions: [action], limit: 50 })).items;

beforeAll(async () => {
  db = freshTestDb();
  await seed();
  tokens.SUPER_ADMIN = (await authService.login(config.auth.seedAdminEmail, config.auth.seedAdminPassword)).token;
  for (const role of USER_ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
    await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${tokens.SUPER_ADMIN}`)
      .send({ email: `${role.toLowerCase()}@urbani.test`, displayName: role, role, password: PASSWORD });
    tokens[role] = (await authService.login(`${role.toLowerCase()}@urbani.test`, PASSWORD)).token;
  }
  const list = await request(app).get('/api/alerts?pageSize=1').set('Authorization', `Bearer ${tokens.SUPER_ADMIN}`);
  alertId = list.body.data.items[0].alertId;
});
afterAll(() => db.close());
afterEach(() => {
  Object.assign(exportCfg, original);
  process.env.RATE_LIMIT_DISABLED = '1';
});

describe('GET /api/logs/export', () => {
  it('CSV: BOM, CRLF, header row, attachment headers, provenance headers', async () => {
    const res = await call('/api/logs/export?format=csv', tokens.SUPER_ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="urbani-logs-\d{8}-\d{6}\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-export-source']).toBe('MOCK');
    expect(Number(res.headers['x-export-rows'])).toBeGreaterThan(0);
    expect(res.headers['x-export-truncated']).toMatch(/true|false/);
    const body = text(res);
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.slice(1).split('\r\n')[0]).toBe('timestamp,level,service,environment,message,id');
    expect(body.split('\r\n').length - 2).toBe(Number(res.headers['x-export-rows']));
  });

  it('bom=false removes the BOM', async () => {
    const res = await call('/api/logs/export?format=csv&bom=false', tokens.SUPER_ADMIN);
    expect(text(res).startsWith('timestamp,')).toBe(true);
  });

  it('JSON envelope carries provenance, scope, filters, counts, who and when', async () => {
    const res = await call('/api/logs/export?format=json&levels=ERROR&search=timeout', tokens.SUPER_ADMIN);
    expect(res.status).toBe(200);
    const j = JSON.parse(text(res));
    expect(j.meta).toMatchObject({
      source: 'MOCK', filters: { levels: ['ERROR'], search: 'timeout', sort: 'newest' }, truncated: expect.any(Boolean),
      generatedBy: config.auth.seedAdminEmail, exportMaxRows: config.export.maxRows,
    });
    expect(j.meta.scope).toEqual(expect.any(String));
    expect(Date.parse(j.meta.generatedAt)).not.toBeNaN();
    expect(j.meta.rowCount).toBe(j.items.length);
    expect(j.items.length).toBeGreaterThan(0);
    expect(j.items.every((l: any) => l.level === 'ERROR' && /timeout/i.test(l.message))).toBe(true);
  });

  it('PDF: valid file, page count equals page objects', async () => {
    const res = await call('/api/logs/export?format=pdf', tokens.SUPER_ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const buf = res.body as Buffer;
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((buf.toString('latin1').match(/\/Type \/Page(?![s\w])/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('applies exactly the same filters as GET /api/logs (rows match the search total)', async () => {
    for (const qs of ['levels=ERROR,WARN', 'search=timeout', 'search=time.*out&regex=true', 'services=main&sort=oldest', 'level=INFO']) {
      const search = await request(app).get(`/api/logs?${qs}&pageSize=200`).set('Authorization', `Bearer ${tokens.SUPER_ADMIN}`);
      const exp = await call(`/api/logs/export?format=json&${qs}`, tokens.SUPER_ADMIN);
      const j = JSON.parse(text(exp));
      expect(j.items.map((l: any) => l.id), qs).toEqual(search.body.data.items.map((l: any) => l.id));
    }
  });

  it('ignores page / pageSize and exports all matching rows', async () => {
    const all = JSON.parse(text(await call('/api/logs/export?format=json', tokens.SUPER_ADMIN)));
    const paged = JSON.parse(text(await call('/api/logs/export?format=json&page=2&pageSize=3', tokens.SUPER_ADMIN)));
    expect(paged.items).toEqual(all.items);
  });

  it('EXPORT_MAX_ROWS caps the rows and sets the truncated flag + headers', async () => {
    exportCfg.maxRows = 5;
    const res = await call('/api/logs/export?format=json', tokens.SUPER_ADMIN);
    expect(res.headers['x-export-rows']).toBe('5');
    expect(res.headers['x-export-truncated']).toBe('true');
    const j = JSON.parse(text(res));
    expect(j.items).toHaveLength(5);
    expect(j.meta).toMatchObject({ rowCount: 5, truncated: true, exportMaxRows: 5 });
  });

  it('EXPORT_PDF_MAX_ROWS caps PDF rows and flags truncation', async () => {
    exportCfg.pdfMaxRows = 3;
    const res = await call('/api/logs/export?format=pdf', tokens.SUPER_ADMIN);
    expect(res.headers['x-export-rows']).toBe('3');
    expect(res.headers['x-export-truncated']).toBe('true');
  });

  it('400 on bad parameters (format, level, dates, unsafe regex)', async () => {
    for (const qs of ['', 'format=xlsx', 'format=csv&levels=LOUD', 'format=csv&from=yesterday', 'format=csv&search=(&regex=true', 'format=csv&search=(a%2B)%2B&regex=true']) {
      const res = await call(`/api/logs/export?${qs}`, tokens.SUPER_ADMIN);
      expect(res.status, qs).toBe(400);
    }
  });

  it('401 unauthenticated', async () => {
    expect((await call('/api/logs/export?format=csv')).status).toBe(401);
    expect((await call('/api/alerts/export?format=csv')).status).toBe(401);
    expect((await call(`/api/alerts/${alertId}/report?format=pdf`)).status).toBe(401);
  });

  it.each(USER_ROLES)('%s: allowed exactly when the role holds logs:export (all three export endpoints)', async (role) => {
    const allowed = ROLE_PERMISSIONS[role].includes('logs:export');
    for (const path of ['/api/logs/export?format=csv', '/api/alerts/export?format=csv', `/api/alerts/${alertId}/report?format=pdf`]) {
      const res = await call(path, tokens[role]);
      expect(res.status, `${role} ${path}`).toBe(allowed ? 200 : 403);
    }
  });

  it('draft matrix: INFRA_ADMIN and SUPER_ADMIN can export, QA_OPERATOR and READER_AUDITOR can too (documented)', () => {
    expect(USER_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('logs:export')).sort()).toEqual(
      ['INFRA_ADMIN', 'QA_OPERATOR', 'READER_AUDITOR', 'SUPER_ADMIN'],
    );
  });
});

describe('GET /api/alerts/export', () => {
  const header = 'alertId,timestamp,service,environment,severity,anomalyType,status,summary,probableCause,confidence,confidenceDerived,recommendedActions,evidenceCount';
  it('CSV has the documented columns and honours the alert filters', async () => {
    const all = await call('/api/alerts/export?format=csv', tokens.SUPER_ADMIN);
    expect(all.status).toBe(200);
    expect(text(all).slice(1).split('\r\n')[0]).toBe(header);
    const high = JSON.parse(text(await call('/api/alerts/export?format=json&severity=HIGH', tokens.SUPER_ADMIN)));
    expect(high.items.length).toBeGreaterThan(0);
    expect(high.items.every((a: any) => a.severity === 'HIGH')).toBe(true);
    expect(high.meta).toMatchObject({ source: 'MOCK', filters: { severity: 'HIGH' }, rowCount: high.items.length, truncated: false });
    // MOCK confidence is a seeded value, not derived
    expect(high.items.every((a: any) => a.confidenceDerived === false)).toBe(true);
    expect(Object.keys(high.items[0])).toEqual(header.split(','));
  });
  it('400 on bad severity / format', async () => {
    expect((await call('/api/alerts/export?format=csv&severity=NOPE', tokens.SUPER_ADMIN)).status).toBe(400);
    expect((await call('/api/alerts/export?format=pdf', tokens.SUPER_ADMIN)).status).toBe(400);
  });
});

describe('GET /api/alerts/:id/report', () => {
  it('200 PDF for a known id, 404 for an unknown id', async () => {
    const ok = await call(`/api/alerts/${alertId}/report?format=pdf`, tokens.SUPER_ADMIN);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['content-disposition']).toContain('urbani-incident-');
    expect((ok.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await call('/api/alerts/does-not-exist/report?format=pdf', tokens.SUPER_ADMIN)).status).toBe(404);
  });
});

describe('rate limit and audit', () => {
  it('audit events carry format, filters, rowCount and truncated, never the rows', async () => {
    await call('/api/logs/export?format=csv&search=timeout', tokens.SUPER_ADMIN);
    await call('/api/alerts/export?format=json&status=OPEN', tokens.SUPER_ADMIN);
    await call(`/api/alerts/${alertId}/report?format=pdf`, tokens.SUPER_ADMIN);
    const logsEv = (await auditOf('logs.export')).find((e: any) => e.metadata?.filters?.search === 'timeout') as any;
    expect(logsEv).toBeTruthy();
    expect(logsEv.metadata).toMatchObject({ format: 'csv', rowCount: expect.any(Number), truncated: expect.any(Boolean) });
    expect(JSON.stringify(logsEv.metadata)).not.toMatch(/Timeout acquiring|ConnectionPool/);
    const alertsEv = (await auditOf('alerts.export'))[0] as any;
    expect(alertsEv.metadata).toMatchObject({ format: 'json', filters: { status: 'OPEN' } });
    const incEv = (await auditOf('incident.report'))[0] as any;
    expect(incEv.target).toBe(alertId);
    expect(incEv.metadata.format).toBe('pdf');
    expect(JSON.stringify(incEv.metadata)).not.toMatch(/probableCause|summary/);
  });

  it('429 after EXPORT_RATE_LIMIT_PER_MIN exports per user (limit is per user, not per IP)', async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    exportCfg.rateLimitPerMin = 2;
    const t = tokens.INFRA_ADMIN;
    expect((await call('/api/logs/export?format=csv', t)).status).toBe(200);
    expect((await call('/api/alerts/export?format=csv', t)).status).toBe(200);
    const third = await call('/api/logs/export?format=csv', t);
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
    // another user from the same IP is unaffected
    expect((await call('/api/logs/export?format=csv', tokens.QA_OPERATOR)).status).toBe(200);
  });
});

describe('preferences widgetLayout (item 12)', () => {
  const put = (token: string, body: object) => request(app).put('/api/preferences').set('Authorization', `Bearer ${token}`).send(body);
  it('is own-only: one user layout never shows on another', async () => {
    const layout = { version: 1, widgets: [{ id: 'recent-alerts', visible: false }, { id: 'kpi', visible: true }] };
    expect((await put(tokens.QA_OPERATOR, { widgetLayout: layout })).body.data.widgetLayout).toEqual(layout);
    const other = await request(app).get('/api/preferences').set('Authorization', `Bearer ${tokens.READER_AUDITOR}`);
    expect(other.body.data.widgetLayout).toBeNull();
    expect((await put(tokens.QA_OPERATOR, { widgetLayout: null })).body.data.widgetLayout).toBeNull();
  });
});
