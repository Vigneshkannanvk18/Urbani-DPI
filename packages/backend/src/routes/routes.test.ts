import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { keySet } from '../test/keySet';
import baseline from './routes.baseline.json';

/**
 * HTTP contract parity (design §8.3, §14 step 1). Replays the 27-step capture sequence in order on a
 * freshly seeded in-memory SQLite store and compares each step's status and recursive key set with
 * routes.baseline.json, which was captured from the unmodified DPI 1 build.
 */

type Method = 'get' | 'post' | 'put';
interface Step {
  id: keyof typeof baseline;
  method: Method;
  path: () => string;
  body?: () => object;
  after?: (body: any) => void;
}

const ctx: { token: string | null; A: string | null; N: string | null } = { token: null, A: null, N: null };

const steps: Step[] = [
  { id: '01-get-health', method: 'get', path: () => '/health' },
  { id: '02-get-ready', method: 'get', path: () => '/ready' },
  {
    id: '03-post-auth-login',
    method: 'post',
    path: () => '/api/auth/login',
    body: () => ({ email: config.auth.seedAdminEmail, password: config.auth.seedAdminPassword }),
    after: (b) => {
      ctx.token = b?.token ?? null;
    },
  },
  { id: '04-get-auth-me', method: 'get', path: () => '/api/auth/me' },
  { id: '05-get-dashboard-summary', method: 'get', path: () => '/api/dashboard/summary' },
  { id: '06-get-dashboard-health', method: 'get', path: () => '/api/dashboard/health' },
  {
    id: '07-get-alerts',
    method: 'get',
    path: () => '/api/alerts',
    after: (b) => {
      ctx.A = b?.data?.items?.[0]?.alertId ?? null;
    },
  },
  { id: '08-get-alert-detail', method: 'get', path: () => `/api/alerts/${encodeURIComponent(ctx.A ?? '')}` },
  { id: '09-get-alert-missing', method: 'get', path: () => '/api/alerts/ALT-DOES-NOT-EXIST' },
  { id: '10-get-logs', method: 'get', path: () => '/api/logs' },
  { id: '11-get-metrics', method: 'get', path: () => '/api/metrics' },
  { id: '12-get-services', method: 'get', path: () => '/api/services' },
  { id: '13-get-service-detail', method: 'get', path: () => '/api/services/svc-main' },
  { id: '14-get-service-missing', method: 'get', path: () => '/api/services/svc-does-not-exist' },
  { id: '15-get-usage', method: 'get', path: () => '/api/usage' },
  { id: '16-get-usage-cost', method: 'get', path: () => '/api/usage/cost' },
  { id: '17-get-settings', method: 'get', path: () => '/api/settings' },
  { id: '18-get-ai-analyses-before-analyze', method: 'get', path: () => '/api/ai/analyses' },
  { id: '19-get-audit-before-writes', method: 'get', path: () => '/api/audit' },
  {
    id: '20-post-ai-analyze',
    method: 'post',
    path: () => '/api/ai/analyze',
    body: () => ({ service: 'main', environment: 'qa' }),
    after: (b) => {
      ctx.N = b?.data?.id ?? null;
    },
  },
  {
    id: '21-post-chat',
    method: 'post',
    path: () => '/api/chat',
    body: () => ({ question: 'Why is main failing?', service: 'main', environment: 'qa' }),
  },
  { id: '22-get-ai-analyses-after-analyze', method: 'get', path: () => '/api/ai/analyses' },
  { id: '23-get-ai-analysis-detail', method: 'get', path: () => `/api/ai/analyses/${encodeURIComponent(ctx.N ?? '')}` },
  {
    id: '24-post-alert-acknowledge',
    method: 'post',
    path: () => `/api/alerts/${encodeURIComponent(ctx.A ?? '')}/acknowledge`,
  },
  { id: '25-put-settings', method: 'put', path: () => '/api/settings', body: () => ({ theme: 'dark' }) },
  { id: '26-get-audit-after-writes', method: 'get', path: () => '/api/audit' },
  { id: '27-post-auth-logout', method: 'post', path: () => '/api/auth/logout' },
];

describe('HTTP route shapes match the DPI 1 baseline', () => {
  const app = createApp();
  let db: ReturnType<typeof freshTestDb>;

  beforeAll(async () => {
    db = freshTestDb();
    await seed();
  });

  afterAll(() => db.close());

  steps.forEach((step, index) => {
    it(`step ${step.id}`, async () => {
      let req = request(app)[step.method](step.path()).set('Accept', 'application/json');
      // Steps 01-03 send no token; from step 04 on, the token captured at step 03.
      if (index >= 3 && ctx.token) req = req.set('Authorization', `Bearer ${ctx.token}`);
      const res = step.body ? await req.send(step.body()) : await req;
      const expected = baseline[step.id];

      expect(res.status).toBe(expected.status);
      expect(keySet(res.body)).toEqual(expected.keys);
      if (step.id === '02-get-ready') {
        expect(res.body).toEqual({ status: 'ready', checks: { database: 'ok' } });
      }
      step.after?.(res.body);
    });
  });
});
