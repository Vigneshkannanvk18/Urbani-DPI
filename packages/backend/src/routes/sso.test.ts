import http from 'node:http';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { userService } from '../services/userService';
import { resetSsoCaches } from '../services/ssoService';

/**
 * SSO / OIDC (DPI 2 item 5) against an in-process FAKE provider with a test JWKS. This proves our
 * Authorization Code + PKCE handling and ID-token validation; it does NOT prove anything about real
 * Cognito or Google.
 */

const CLIENT_ID = 'client-1';
const REDIRECT = 'http://localhost:4100/api/auth/sso/callback';
const GROUP_MAP = {
  'urbani-super-admins': 'SUPER_ADMIN',
  'urbani-infra-admins': 'INFRA_ADMIN',
  'urbani-qa-operators': 'QA_OPERATOR',
  'urbani-readers': 'READER_AUDITOR',
};
const app = createApp();
let db: ReturnType<typeof freshTestDb>;

// ---------------- fake provider ----------------
let server: http.Server;
let base = '';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const codes = new Map<string, { claims: Record<string, unknown>; challenge: string; signWith: KeyObject }>();
let tokenCalls = 0;

function jwks() {
  return { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    const json = (o: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
    }
    if (url.pathname === '/jwks') return json(jwks());
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        tokenCalls++;
        const p = new URLSearchParams(raw);
        const entry = codes.get(p.get('code') ?? '');
        const verifier = p.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!entry || entry.challenge !== challenge || p.get('redirect_uri') !== REDIRECT || p.get('client_id') !== CLIENT_ID) {
          return json({ error: 'invalid_grant' }, 400);
        }
        codes.delete(p.get('code') ?? '');
        const idToken = jwt.sign(entry.claims, entry.signWith, { algorithm: 'RS256', keyid: 'k1' });
        json({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  db = freshTestDb();
  await seed();
  resetSsoCaches();
  tokenCalls = 0;
  Object.assign(process.env, {
    AUTH_PROVIDER: 'oidc', OIDC_ISSUER: base, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_REDIRECT_URI: REDIRECT, OIDC_GROUP_ROLE_MAP: JSON.stringify(GROUP_MAP), OIDC_ALLOWED_EMAIL_DOMAIN: 'urbani.io',
  });
});
afterEach(() => {
  for (const k of ['AUTH_PROVIDER', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OIDC_GROUP_ROLE_MAP',
    'OIDC_ALLOWED_EMAIL_DOMAIN', 'OIDC_AUTO_PROVISION', 'AUTH_LOCAL_ENABLED']) delete process.env[k];
  db.close();
});

interface FlowOpts {
  claims?: Record<string, unknown>;
  state?: string;
  noCookie?: boolean;
  signWith?: KeyObject;
  nonce?: string;
}
/** Drives login -> (fake IdP issues a code) -> callback. Returns the callback response. */
async function flow(opts: FlowOpts = {}) {
  const start = await request(app).get('/api/auth/sso/login');
  expect(start.status).toBe(302);
  const authUrl = new URL(start.headers.location);
  const q = authUrl.searchParams;
  expect(q.get('code_challenge_method')).toBe('S256');
  expect(q.get('response_type')).toBe('code');
  expect(q.get('scope')).toBe('openid email profile');
  const cookie = (start.headers['set-cookie'] as unknown as string[])[0];
  expect(cookie).toContain('HttpOnly');
  const now = Math.floor(Date.now() / 1000);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  codes.set(code, {
    challenge: q.get('code_challenge') as string,
    signWith: opts.signWith ?? keys.privateKey,
    claims: {
      iss: base, aud: CLIENT_ID, sub: 'idp-user-1', iat: now, exp: now + 300, nonce: opts.nonce ?? q.get('nonce'),
      email: 'jane@urbani.io', email_verified: true, name: 'Jane Doe', 'cognito:groups': ['urbani-readers'],
      ...opts.claims,
    },
  });
  const req = request(app)
    .get('/api/auth/sso/callback')
    .query({ code, state: opts.state ?? q.get('state') })
    .set('Accept', 'application/json');
  if (!opts.noCookie) req.set('Cookie', cookie.split(';')[0]);
  return req;
}

const actions = async () => (await getRepositories().audit.query({})).items.map((e) => e.action);
const expectDenied = async (res: request.Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
  expect(res.headers.location).toBeUndefined();
  expect(await actions()).toContain('sso.denied');
};

describe('GET /api/auth/config', () => {
  it('reports SSO state without secrets', async () => {
    const res = await request(app).get('/api/auth/config');
    expect(res.body).toEqual({ provider: 'oidc', ssoEnabled: true, localEnabled: true, ssoLoginUrl: '/api/auth/sso/login' });
    expect(JSON.stringify(res.body)).not.toContain('test-secret');
  });
  it('defaults to local only', async () => {
    delete process.env.AUTH_PROVIDER;
    const res = await request(app).get('/api/auth/config');
    expect(res.body).toEqual({ provider: 'local', ssoEnabled: false, localEnabled: true, ssoLoginUrl: null });
    expect((await request(app).get('/api/auth/sso/login')).status).toBe(404);
  });
  it('local login can be disabled when SSO is usable (and never when it is not)', async () => {
    process.env.AUTH_LOCAL_ENABLED = 'false';
    expect((await request(app).get('/api/auth/config')).body).toMatchObject({ ssoEnabled: true, localEnabled: false });
    const login = await request(app).post('/api/auth/login').send({ email: 'admin@urbani.local', password: 'ChangeMe123!' });
    expect(login.status).toBe(403);
    delete process.env.OIDC_ISSUER; // SSO unusable -> local stays available, so nobody is locked out
    expect((await request(app).get('/api/auth/config')).body).toMatchObject({ ssoEnabled: false, localEnabled: true });
  });
});

describe('SSO login', () => {
  it('success: auto-provisions, maps the group, redirects with a normal session, audits', async () => {
    const res = await flow();
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/sso-callback#token=/);
    const token = decodeURIComponent(res.headers.location.split('token=')[1]);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: 'jane@urbani.io', displayName: 'Jane Doe', rbacRole: 'READER_AUDITOR' });
    expect((await request(app).get('/api/dashboard/summary').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const user = (await getRepositories().users.list()).find((u) => u.email === 'jane@urbani.io')!;
    expect((await getRepositories().users.getSecurity(user.id)).authSource).toBe('sso');
    expect(await actions()).toEqual(expect.arrayContaining(['auth.sso_login', 'user.provisioned']));
    // SSO users have no local password and no local TOTP step.
    const local = await request(app).post('/api/auth/login').send({ email: 'jane@urbani.io', password: 'anything-at-all' });
    expect(local.status).toBe(401);
    expect(JSON.stringify(await getRepositories().audit.query({}))).not.toContain(token);
  });

  it('rejects a bad state and a missing/expired state cookie', async () => {
    await expectDenied(await flow({ state: 'forged' }), 400, 'SSO_STATE_INVALID');
    await expectDenied(await flow({ noCookie: true }), 400, 'SSO_STATE_INVALID');
    expect(tokenCalls).toBe(0);
  });

  it('rejects a wrong nonce, an expired token, a wrong audience, a wrong issuer and a bad signature', async () => {
    await expectDenied(await flow({ nonce: 'other' }), 401, 'SSO_INVALID_TOKEN');
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expectDenied(await flow({ claims: { exp: past, iat: past - 300 } }), 401, 'SSO_INVALID_TOKEN');
    await expectDenied(await flow({ claims: { aud: 'someone-else' } }), 401, 'SSO_INVALID_TOKEN');
    await expectDenied(await flow({ claims: { iss: 'http://evil.example' } }), 401, 'SSO_INVALID_TOKEN');
    await expectDenied(await flow({ signWith: otherKeys.privateKey }), 401, 'SSO_INVALID_TOKEN');
    expect((await getRepositories().users.list()).some((u) => u.email === 'jane@urbani.io')).toBe(false);
  });

  it('rejects unverified email, missing email and a wrong domain', async () => {
    await expectDenied(await flow({ claims: { email_verified: false } }), 403, 'SSO_EMAIL_UNVERIFIED');
    await expectDenied(await flow({ claims: { email: undefined } }), 403, 'SSO_EMAIL_REQUIRED');
    await expectDenied(await flow({ claims: { email: 'mallory@gmail.com' } }), 403, 'SSO_DOMAIN_NOT_ALLOWED');
  });

  it('accepts email_verified as the string "true" (Cognito)', async () => {
    expect((await flow({ claims: { email_verified: 'true' } })).status).toBe(302);
  });

  it('maps groups to roles using the HIGHEST privilege', async () => {
    const cases: [string[], string][] = [
      [['urbani-readers', 'urbani-qa-operators'], 'QA_OPERATOR'],
      [['urbani-readers', 'urbani-infra-admins', 'urbani-qa-operators'], 'INFRA_ADMIN'],
      [['urbani-qa-operators', 'urbani-super-admins', 'unrelated'], 'SUPER_ADMIN'],
    ];
    for (const [groups, role] of cases) {
      const res = await flow({ claims: { 'cognito:groups': groups, email: `u-${role.toLowerCase()}@urbani.io` } });
      expect(res.status).toBe(302);
      const user = (await getRepositories().users.list()).find((u) => u.email === `u-${role.toLowerCase()}@urbani.io`)!;
      expect(user.role).toBe(role);
    }
  });

  it('denies a user with no mapped group (403 + sso.denied) and creates nothing', async () => {
    await expectDenied(await flow({ claims: { 'cognito:groups': ['some-other-group'] } }), 403, 'SSO_NO_ROLE');
    await expectDenied(await flow({ claims: { 'cognito:groups': undefined } }), 403, 'SSO_NO_ROLE');
    expect((await getRepositories().users.list()).some((u) => u.email === 'jane@urbani.io')).toBe(false);
  });

  it('browser callers get an HTML error page instead of JSON', async () => {
    const start = await request(app).get('/api/auth/sso/login');
    const res = await request(app).get('/api/auth/sso/callback').query({ code: 'x', state: 'bad' }).set('Cookie', (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0]);
    expect(res.status).toBe(400);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('Sign-in failed');
  });

  it('re-syncs the role on every SSO login', async () => {
    expect((await flow()).status).toBe(302);
    const find = async () => (await getRepositories().users.list()).find((u) => u.email === 'jane@urbani.io')!;
    expect((await find()).role).toBe('READER_AUDITOR');
    expect((await flow({ claims: { 'cognito:groups': ['urbani-infra-admins'] } })).status).toBe(302);
    expect((await find()).role).toBe('INFRA_ADMIN');
    expect((await flow({ claims: { 'cognito:groups': ['urbani-qa-operators'] } })).status).toBe(302);
    expect((await find()).role).toBe('QA_OPERATOR');
  });

  it('a deactivated user record blocks SSO', async () => {
    expect((await flow()).status).toBe(302);
    const user = (await getRepositories().users.list()).find((u) => u.email === 'jane@urbani.io')!;
    const admin = (await getRepositories().users.list()).find((u) => u.email === 'admin@urbani.local')!;
    await userService.setActive({ id: admin.id, email: admin.email }, user.id, false);
    await expectDenied(await flow(), 403, 'SSO_USER_INACTIVE');
  });

  it('OIDC_AUTO_PROVISION=false denies unknown users but still admits existing ones', async () => {
    process.env.OIDC_AUTO_PROVISION = 'false';
    await expectDenied(await flow(), 403, 'SSO_NOT_PROVISIONED');
    await userService.create('test', { email: 'jane@urbani.io', displayName: 'Jane', role: 'QA_OPERATOR', password: 'Str0ng-Passw0rd!' });
    const ok = await flow({ claims: { 'cognito:groups': ['urbani-readers'] } });
    expect(ok.status).toBe(302);
    const user = (await getRepositories().users.list()).find((u) => u.email === 'jane@urbani.io')!;
    expect(user.role).toBe('READER_AUDITOR'); // role comes from the IdP
  });

  it('the authorization code cannot be replayed (PKCE + one-time code at the provider)', async () => {
    const start = await request(app).get('/api/auth/sso/login');
    const q = new URL(start.headers.location).searchParams;
    const cookie = (start.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const now = Math.floor(Date.now() / 1000);
    codes.set('once', {
      challenge: q.get('code_challenge') as string, signWith: keys.privateKey,
      claims: { iss: base, aud: CLIENT_ID, exp: now + 300, nonce: q.get('nonce'), email: 'jane@urbani.io', email_verified: true, 'cognito:groups': ['urbani-readers'] },
    });
    const call = () => request(app).get('/api/auth/sso/callback').query({ code: 'once', state: q.get('state') }).set('Cookie', cookie).set('Accept', 'application/json');
    expect((await call()).status).toBe(302);
    expect((await call()).status).toBe(502);
  });
});
