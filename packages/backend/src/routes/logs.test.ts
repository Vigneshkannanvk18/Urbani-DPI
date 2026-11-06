import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { authService } from '../services/authService';
import { parseLogSearch } from '../lib/logQuery';

/** Log search API (DPI 2 item 4): filters, validation, regex safety, audit. */
const app = createApp();
let db: ReturnType<typeof freshTestDb>;
let token = '';
const get = (qs: string) => request(app).get(`/api/logs${qs}`).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  db = freshTestDb();
  await seed();
  token = (await authService.login(config.auth.seedAdminEmail, config.auth.seedAdminPassword)).token;
});
afterAll(() => db.close());

describe('parseLogSearch', () => {
  it('merges legacy and new params, accepts csv and repeated values', () => {
    const s = parseLogSearch({ level: 'ERROR', levels: 'WARN,ERROR', service: 'main', services: ['payments'], text: 'x', regex: 'true' }, 200);
    expect(s.levels.sort()).toEqual(['ERROR', 'WARN']);
    expect(s.services.sort()).toEqual(['main', 'payments']);
    expect(s.search).toBe('x');
    expect(s.regex).toBe(true);
    expect(s.sort).toBe('newest');
  });
  it('rejects bad levels, dates, ranges and regex', () => {
    expect(() => parseLogSearch({ levels: 'LOUD' }, 200)).toThrow();
    expect(() => parseLogSearch({ from: 'yesterday' }, 200)).toThrow();
    expect(() => parseLogSearch({ from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' }, 200)).toThrow(/from must not be after to/);
    expect(() => parseLogSearch({ search: '(', regex: 'true' }, 200)).toThrow(/Invalid regular expression/);
  });
});

describe('GET /api/logs', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/logs')).status).toBe(401);
  });

  it('stays backward compatible with the original params and adds search meta', async () => {
    const res = await get('?level=ERROR&search=timeout&page=1&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('MOCK');
    expect(res.body.data.items.every((l: any) => l.level === 'ERROR' && /timeout/i.test(l.message))).toBe(true);
    expect(res.body.meta.applied).toEqual({ levels: ['ERROR'], search: 'timeout' });
    expect(res.body.meta.scope).toBeTruthy();
    expect(typeof res.body.meta.truncated).toBe('boolean');
  });

  it('filters by multiple levels, server, regex and paginates', async () => {
    const all = await get('?levels=ERROR,WARN&services=main&sort=oldest&pageSize=3&page=1');
    expect(all.status).toBe(200);
    expect(all.body.data.items).toHaveLength(3);
    expect(all.body.data.items.every((l: any) => ['ERROR', 'WARN'].includes(l.level) && l.service === 'main')).toBe(true);
    const ts = all.body.data.items.map((l: any) => Date.parse(l.timestamp));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    const p2 = await get('?levels=ERROR,WARN&services=main&sort=oldest&pageSize=3&page=2');
    expect(p2.body.data.items[0].id).not.toBe(all.body.data.items[0].id);
    expect(p2.body.data.total).toBe(all.body.data.total);

    const rx = await get('?search=timeout%7Cexhausted&regex=true');
    expect(rx.status).toBe(200);
    expect(rx.body.data.items.length).toBeGreaterThan(0);
    expect(rx.body.meta.applied.regex).toBe(true);
  });

  it('filters by date range', async () => {
    const full = await get('?sort=oldest&pageSize=200');
    const items = full.body.data.items;
    const from = encodeURIComponent(items[5].timestamp);
    const to = encodeURIComponent(items[9].timestamp);
    const res = await get(`?from=${from}&to=${to}&pageSize=200`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(5);
  });

  it('returns 400 for invalid dates, ranges, levels, bad and catastrophic regex (quickly)', async () => {
    const started = Date.now();
    for (const qs of [
      '?from=not-a-date',
      '?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z',
      '?levels=LOUD',
      '?search=(&regex=true',
      '?search=(a%2B)%2B%24&regex=true',
      `?search=${'a'.repeat(201)}&regex=true`,
      '?search=(a)%5C1&regex=true',
    ]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.message).toBeTruthy();
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('records a logs.search audit event with the filter parameters (no log content)', async () => {
    await get('?levels=ERROR&services=main&search=pool&regex=true&from=2026-09-01T00:00:00Z&sort=oldest');
    const events = (await getRepositories().audit.listByTimeRange({ actions: ['logs.search'], limit: 200 })).items;
    const e = events.find((x) => JSON.stringify(x.metadata).includes('"oldest"'));
    expect(e).toBeTruthy();
    const md = e!.metadata as any;
    expect(md).toMatchObject({ levels: ['ERROR'], services: ['main'], search: 'pool', regex: true, from: '2026-09-01T00:00:00Z', sort: 'oldest' });
    expect(JSON.stringify(md)).not.toMatch(/DB connection pool/i);
  });
});
