import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { USER_ROLES, ROLE_PERMISSIONS, PERMISSIONS, permissionsForRole, type UserRole } from '@urbani/shared';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { authService } from '../services/authService';
import { userService, ConflictError } from '../services/userService';

/**
 * RBAC (DPI 2 item 2): per-role route access against the real Express app, the read-only guarantee for
 * READER_AUDITOR, user-management guard rails. The matrix asserted here is the DRAFT matrix
 * (pending Urbani sign-off); the expectations are written out explicitly on purpose.
 */

const PASSWORD = 'Str0ng-Passw0rd!';
const app = createApp();
let db: ReturnType<typeof freshTestDb>;
let alertId = '';
let untouchedAlertId = '';
const tokens = {} as Record<UserRole, string>;
const ids = {} as Record<UserRole, string>;

const get = (path: string, token?: string) => {
  const r = request(app).get(path);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
const send = (method: 'post' | 'put', path: string, token: string | undefined, body?: object) => {
  const r = request(app)[method](path).send(body ?? {});
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

interface Route {
  name: string;
  method: 'get' | 'post' | 'put';
  path: () => string;
  body?: object;
  mutating: boolean;
  allowed: UserRole[];
}
const ALL = [...USER_ROLES];
const NOT_READER = ALL.filter((r) => r !== 'READER_AUDITOR');
const routes: Route[] = [
  { name: 'dashboard summary', method: 'get', path: () => '/api/dashboard/summary', mutating: false, allowed: ALL },
  { name: 'dashboard health', method: 'get', path: () => '/api/dashboard/health', mutating: false, allowed: ALL },
  { name: 'alerts list', method: 'get', path: () => '/api/alerts', mutating: false, allowed: ALL },
  { name: 'alert detail', method: 'get', path: () => `/api/alerts/${encodeURIComponent(alertId)}`, mutating: false, allowed: ALL },
  { name: 'logs', method: 'get', path: () => '/api/logs', mutating: false, allowed: ALL },
  { name: 'metrics', method: 'get', path: () => '/api/metrics', mutating: false, allowed: ALL },
  { name: 'services', method: 'get', path: () => '/api/services', mutating: false, allowed: ALL },
  { name: 'ai analyses', method: 'get', path: () => '/api/ai/analyses', mutating: false, allowed: ALL },
  { name: 'usage', method: 'get', path: () => '/api/usage', mutating: false, allowed: ALL },
  { name: 'usage cost', method: 'get', path: () => '/api/usage/cost', mutating: false, allowed: ALL },
  { name: 'settings view', method: 'get', path: () => '/api/settings', mutating: false, allowed: ALL },
  { name: 'audit', method: 'get', path: () => '/api/audit', mutating: false, allowed: ['SUPER_ADMIN', 'INFRA_ADMIN', 'READER_AUDITOR'] },
  { name: 'users list', method: 'get', path: () => '/api/users', mutating: false, allowed: ['SUPER_ADMIN'] },
  // chat:use is deliberately allowed for the read-only auditor (advisory only; DRAFT judgment call)
  {
    name: 'chat',
    method: 'post',
    path: () => '/api/chat',
    body: { question: 'Why is main failing?', service: 'main', environment: 'qa' },
    mutating: false,
    allowed: ALL,
  },
  { name: 'alert acknowledge', method: 'post', path: () => `/api/alerts/${encodeURIComponent(alertId)}/acknowledge`, mutating: true, allowed: NOT_READER },
  {
    name: 'ai analyze',
    method: 'post',
    path: () => '/api/ai/analyze',
    body: { service: 'main', environment: 'qa' },
    mutating: true,
    allowed: NOT_READER,
  },
  { name: 'settings update', method: 'put', path: () => '/api/settings', body: { theme: 'dark' }, mutating: true, allowed: ['SUPER_ADMIN', 'INFRA_ADMIN'] },
  {
    name: 'user create',
    method: 'post',
    path: () => '/api/users',
    body: { email: 'x@urbani.test', displayName: 'X', role: 'READER_AUDITOR', password: PASSWORD },
    mutating: true,
    allowed: ['SUPER_ADMIN'],
  },
  { name: 'user role change', method: 'put', path: () => `/api/users/${ids.QA_OPERATOR}/role`, body: { role: 'SUPER_ADMIN' }, mutating: true, allowed: ['SUPER_ADMIN'] },
  { name: 'user deactivate', method: 'post', path: () => `/api/users/${ids.QA_OPERATOR}/deactivate`, mutating: true, allowed: ['SUPER_ADMIN'] },
  { name: 'user activate', method: 'post', path: () => `/api/users/${ids.QA_OPERATOR}/activate`, mutating: true, allowed: ['SUPER_ADMIN'] },
  { name: 'user reset password', method: 'post', path: () => `/api/users/${ids.QA_OPERATOR}/reset-password`, body: { password: PASSWORD }, mutating: true, allowed: ['SUPER_ADMIN'] },
];

beforeAll(async () => {
  db = freshTestDb();
  await seed();
  const admin = await authService.login(config.auth.seedAdminEmail, config.auth.seedAdminPassword);
  tokens.SUPER_ADMIN = admin.token;
  ids.SUPER_ADMIN = admin.user.id;
  for (const role of USER_ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
    const res = await send('post', '/api/users', tokens.SUPER_ADMIN, {
      email: `${role.toLowerCase()}@urbani.test`,
      displayName: role,
      role,
      password: PASSWORD,
    });
    expect(res.status).toBe(201);
    ids[role] = res.body.data.id;
    tokens[role] = (await authService.login(`${role.toLowerCase()}@urbani.test`, PASSWORD)).token;
  }
  const items = (await get('/api/alerts', tokens.SUPER_ADMIN)).body.data.items;
  alertId = items[0].alertId;
  untouchedAlertId = items[1].alertId; // never acknowledged by the per-role loop
});
afterAll(() => db.close());

describe('RBAC route access per role (DRAFT matrix)', () => {
  it('rejects unauthenticated calls to every route with 401', async () => {
    for (const r of routes) {
      const res = r.method === 'get' ? await get(r.path()) : await send(r.method, r.path(), undefined, r.body);
      expect(res.status, r.name).toBe(401);
    }
  });

  for (const role of USER_ROLES) {
    it(`${role}: allowed routes succeed, others return 403 FORBIDDEN`, async () => {
      // Run state-changing user-management routes last and only for the role that may use them,
      // so earlier results are not skewed by a role/active change on the shared QA user.
      const ordered = [...routes].sort((a, b) => Number(a.path().startsWith('/api/users/')) - Number(b.path().startsWith('/api/users/')));
      for (const r of ordered) {
        if (r.name === 'user deactivate' || r.name === 'user activate' || r.name === 'user role change') {
          if (role === 'SUPER_ADMIN') continue; // exercised in the guard-rail tests instead
        }
        const res = r.method === 'get' ? await get(r.path(), tokens[role]) : await send(r.method, r.path(), tokens[role], r.body);
        if (r.allowed.includes(role)) {
          expect(res.status, `${role} ${r.name}`).toBeLessThan(300);
          expect(res.status, `${role} ${r.name}`).toBeGreaterThanOrEqual(200);
        } else {
          expect(res.status, `${role} ${r.name}`).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
      }
    });
  }

  it('READER_AUDITOR cannot call any mutating endpoint (all 403, nothing changed)', async () => {
    const mutating = routes.filter((r) => r.mutating);
    expect(mutating.length).toBeGreaterThanOrEqual(8);
    for (const r of mutating) {
      const path = r.name === 'alert acknowledge' ? `/api/alerts/${encodeURIComponent(untouchedAlertId)}/acknowledge` : r.path();
      const res = await send(r.method as 'post' | 'put', path, tokens.READER_AUDITOR, r.body);
      expect(res.status, r.name).toBe(403);
    }
    const alert = (await get(`/api/alerts/${encodeURIComponent(untouchedAlertId)}`, tokens.SUPER_ADMIN)).body.data;
    expect(alert.status).not.toBe('ACKNOWLEDGED');
    expect(permissionsForRole('READER_AUDITOR').filter((p) => /:(acknowledge|analyze|update|manage)$/.test(p))).toEqual([]);
  });

  it('records denied attempts in the audit trail', async () => {
    const { items } = await getRepositories().audit.query({ action: 'access.denied' });
    expect(items.length).toBeGreaterThan(0);
  });

  it('the shared matrix gives SUPER_ADMIN everything and only SUPER_ADMIN users:manage', () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN).toEqual(PERMISSIONS);
    expect(USER_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('users:manage'))).toEqual(['SUPER_ADMIN']);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the RBAC role and the effective permission list', async () => {
    const res = await get('/api/auth/me', tokens.QA_OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body.user.rbacRole).toBe('QA_OPERATOR');
    expect(res.body.user.rbacRoleName).toBe('QA Operator');
    expect(res.body.user.permissions).toEqual(permissionsForRole('QA_OPERATOR'));
  });
  it('the seeded admin is SUPER_ADMIN', async () => {
    const res = await get('/api/auth/me', tokens.SUPER_ADMIN);
    expect(res.body.user.rbacRole).toBe('SUPER_ADMIN');
  });
});

describe('user management', () => {
  it('validates input (short password, bad role, missing role, bad email)', async () => {
    const base = { email: 'v@urbani.test', displayName: 'V', role: 'QA_OPERATOR', password: PASSWORD };
    for (const bad of [{ password: 'short' }, { role: 'GOD' }, { role: undefined }, { email: 'nope' }]) {
      const res = await send('post', '/api/users', tokens.SUPER_ADMIN, { ...base, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('rejects a duplicate email with 409 and never returns password hashes', async () => {
    const res = await send('post', '/api/users', tokens.SUPER_ADMIN, {
      email: 'QA_OPERATOR@urbani.test',
      displayName: 'Dup',
      role: 'QA_OPERATOR',
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    const list = await get('/api/users', tokens.SUPER_ADMIN);
    expect(JSON.stringify(list.body)).not.toMatch(/password/i);
    expect(list.body.data.filter((u: { email: string }) => u.email === 'qa_operator@urbani.test')).toHaveLength(1);
  });

  it('cannot change your own role or deactivate yourself', async () => {
    const role = await send('put', `/api/users/${ids.SUPER_ADMIN}/role`, tokens.SUPER_ADMIN, { role: 'QA_OPERATOR' });
    expect(role.status).toBe(409);
    const deact = await send('post', `/api/users/${ids.SUPER_ADMIN}/deactivate`, tokens.SUPER_ADMIN);
    expect(deact.status).toBe(409);
  });

  it('protects the last active SUPER_ADMIN (demote and deactivate by another actor)', async () => {
    const other = { id: 'someone-else', email: 'other@urbani.test' };
    await expect(userService.changeRole(other, ids.SUPER_ADMIN, 'QA_OPERATOR')).rejects.toBeInstanceOf(ConflictError);
    await expect(userService.setActive(other, ids.SUPER_ADMIN, false)).rejects.toBeInstanceOf(ConflictError);
    // With a second active Super Admin the same actions are allowed.
    const second = await userService.create('t', { email: 'second@urbani.test', displayName: 'S', role: 'SUPER_ADMIN', password: PASSWORD });
    const demoted = await userService.changeRole(other, ids.SUPER_ADMIN, 'INFRA_ADMIN');
    expect(demoted.role).toBe('INFRA_ADMIN');
    await expect(userService.setActive(other, second.id, false)).rejects.toBeInstanceOf(ConflictError);
    await userService.changeRole(other, ids.SUPER_ADMIN, 'SUPER_ADMIN'); // restore
  });

  it('a role change takes effect on the next request with the same token', async () => {
    const before = await send('post', `/api/alerts/${encodeURIComponent(alertId)}/acknowledge`, tokens.READER_AUDITOR);
    expect(before.status).toBe(403);
    const change = await send('put', `/api/users/${ids.READER_AUDITOR}/role`, tokens.SUPER_ADMIN, { role: 'QA_OPERATOR' });
    expect(change.status).toBe(200);
    const after = await send('post', `/api/alerts/${encodeURIComponent(alertId)}/acknowledge`, tokens.READER_AUDITOR);
    expect(after.status).toBe(200);
    await send('put', `/api/users/${ids.READER_AUDITOR}/role`, tokens.SUPER_ADMIN, { role: 'READER_AUDITOR' });
  });

  it('a deactivated user cannot log in and an existing token stops working; reactivation restores access', async () => {
    const email = 'infra_admin@urbani.test';
    expect((await request(app).post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
    expect((await send('post', `/api/users/${ids.INFRA_ADMIN}/deactivate`, tokens.SUPER_ADMIN)).status).toBe(200);
    expect((await get('/api/alerts', tokens.INFRA_ADMIN)).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
    expect((await send('post', `/api/users/${ids.INFRA_ADMIN}/activate`, tokens.SUPER_ADMIN)).status).toBe(200);
    expect((await get('/api/alerts', tokens.INFRA_ADMIN)).status).toBe(200);
  });

  it('reset password replaces the credential', async () => {
    const email = 'qa_operator@urbani.test';
    const next = 'An0ther-Passw0rd!';
    expect((await send('post', `/api/users/${ids.QA_OPERATOR}/reset-password`, tokens.SUPER_ADMIN, { password: 'short' })).status).toBe(400);
    expect((await send('post', `/api/users/${ids.QA_OPERATOR}/reset-password`, tokens.SUPER_ADMIN, { password: next })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email, password: next })).status).toBe(200);
  });

  it('writes audit events for user management and failed logins', async () => {
    const audit = getRepositories().audit;
    for (const action of ['user.create', 'user.role_change', 'user.deactivate', 'user.activate', 'user.password_reset', 'auth.login_failed']) {
      const { total } = await audit.query({ action });
      expect(total, action).toBeGreaterThan(0);
    }
  });

  it('returns 404 for an unknown user id', async () => {
    expect((await send('post', '/api/users/nope/deactivate', tokens.SUPER_ADMIN)).status).toBe(404);
  });
});
