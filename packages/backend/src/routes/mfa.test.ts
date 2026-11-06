import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@urbani/shared';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { userService } from '../services/userService';
import { totpNow } from '../lib/totp';
import { decryptSecret } from '../lib/totp';

/** MFA (DPI 2 item 5): TOTP enrolment, login second step, lockout, replay, recovery, policy, reset. */

const PASSWORD = 'Str0ng-Passw0rd!';
const app = createApp();
let db: ReturnType<typeof freshTestDb>;
let offsetMs = 0;
const realNow = Date.now.bind(Date);

const post = (path: string, token: string | undefined, body: object = {}) => {
  const r = request(app).post(path).send(body);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
const get = (path: string, token?: string) => {
  const r = request(app).get(path);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
/** Move the clock forward by whole TOTP steps so each code lies in a fresh time-step. */
const nextStep = (n = 1) => { offsetMs += n * 30_000; };
const code = (secret: string) => totpNow(secret, Date.now());
/** A well-formed 6-digit code that is not valid in the current +-1 window. */
const wrongCode = (secret: string) => {
  const valid = [-1, 0, 1].map((d) => totpNow(secret, Date.now() + d * 30_000));
  return ['000000', '111111', '222222'].find((c) => !valid.includes(c)) as string;
};

async function makeUser(role: UserRole, name = role.toLowerCase()) {
  const email = `${name}@urbani.test`;
  const u = await userService.create('test', { email, displayName: name, role, password: PASSWORD });
  return { id: u.id, email };
}
const login = (email: string) => post('/api/auth/login', undefined, { email, password: PASSWORD });

async function adminToken(): Promise<string> {
  const res = await post('/api/auth/login', undefined, { email: config.auth.seedAdminEmail, password: config.auth.seedAdminPassword });
  return res.body.token;
}

/** Enrol a user fully; returns session token, secret and recovery codes. */
async function enrol(email: string) {
  const token = (await login(email)).body.token as string;
  const start = await post('/api/auth/mfa/enroll/start', token);
  expect(start.status).toBe(200);
  const secret = start.body.secret as string;
  nextStep();
  const confirm = await post('/api/auth/mfa/enroll/confirm', token, { code: code(secret) });
  expect(confirm.status).toBe(200);
  return { token, secret, recoveryCodes: confirm.body.recoveryCodes as string[], start };
}

beforeEach(async () => {
  offsetMs = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
  delete process.env.MFA_REQUIRED_ROLES;
  db = freshTestDb();
  await seed();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MFA_REQUIRED_ROLES;
  db.close();
});

describe('TOTP enrolment', () => {
  it('start returns an otpauth URI (issuer Urbani Radar, account = email), a QR data URL and a manual key; not active until confirmed', async () => {
    const u = await makeUser('INFRA_ADMIN');
    const token = (await login(u.email)).body.token;
    const start = await post('/api/auth/mfa/enroll/start', token);
    expect(start.body.otpauthUri).toContain('otpauth://totp/Urbani%20Radar:infra_admin%40urbani.test');
    expect(start.body.otpauthUri).toContain(`secret=${start.body.secret}`);
    expect(start.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect((await get('/api/auth/mfa/status', token)).body.enabled).toBe(false);
    // Still a plain password login (no MFA until confirmed).
    expect((await login(u.email)).body.token).toBeTruthy();
  });

  it('rejects a wrong confirm code; confirm with a valid code enables MFA and returns 10 recovery codes once', async () => {
    const u = await makeUser('INFRA_ADMIN');
    const token = (await login(u.email)).body.token;
    const secret = (await post('/api/auth/mfa/enroll/start', token)).body.secret;
    expect((await post('/api/auth/mfa/enroll/confirm', token, { code: wrongCode(secret) })).status).toBe(401);
    const ok = await post('/api/auth/mfa/enroll/confirm', token, { code: code(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    const st = await get('/api/auth/mfa/status', token);
    expect(st.body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
    expect((await post('/api/auth/mfa/enroll/start', token)).status).toBe(409);
  });

  it('stores the secret encrypted (round trip) and recovery codes only as hashes', async () => {
    const u = await makeUser('INFRA_ADMIN');
    const { secret, recoveryCodes } = await enrol(u.email);
    const row = db.prepare('SELECT mfa_secret_encrypted, mfa_recovery_hashes FROM users WHERE email = ?').get(u.email) as {
      mfa_secret_encrypted: string; mfa_recovery_hashes: string;
    };
    expect(row.mfa_secret_encrypted).not.toContain(secret);
    expect(decryptSecret(row.mfa_secret_encrypted)).toBe(secret);
    for (const c of recoveryCodes) expect(row.mfa_recovery_hashes).not.toContain(c.replace('-', ''));
    expect(JSON.parse(row.mfa_recovery_hashes)).toHaveLength(10);
  });
});

describe('login with MFA', () => {
  it('password login returns mfaRequired + a scoped mfaToken and NO session; verify returns the normal session', async () => {
    const u = await makeUser('QA_OPERATOR');
    const { secret } = await enrol(u.email);
    nextStep();
    const res = await login(u.email);
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    const claims = jwt.decode(res.body.mfaToken) as { purpose: string; exp: number; iat: number };
    expect(claims.purpose).toBe('mfa');
    expect(claims.exp - claims.iat).toBe(300);

    const v = await post('/api/auth/mfa/verify', undefined, { mfaToken: res.body.mfaToken, code: code(secret) });
    expect(v.status).toBe(200);
    expect(v.body.user.email).toBe(u.email);
    expect((await get('/api/auth/me', v.body.token)).status).toBe(200);
  });

  it('the mfaToken cannot access any other route (including MFA enrolment endpoints)', async () => {
    const u = await makeUser('QA_OPERATOR');
    await enrol(u.email);
    nextStep();
    const { mfaToken } = (await login(u.email)).body;
    for (const path of ['/api/auth/me', '/api/dashboard/summary', '/api/alerts', '/api/auth/mfa/status']) {
      expect((await get(path, mfaToken)).status, path).toBe(401);
    }
    expect((await post('/api/auth/logout', mfaToken)).status).toBe(401);
    expect((await post('/api/auth/mfa/enroll/start', mfaToken)).status).toBe(401);
    // A normal session token is not an mfaToken either.
    const session = (await post('/api/auth/mfa/verify', undefined, { mfaToken: 'x', code: '123456' }));
    expect(session.status).toBe(401);
  });

  it('wrong code gives a generic 401', async () => {
    const u = await makeUser('QA_OPERATOR');
    const { secret } = await enrol(u.email);
    nextStep();
    const { mfaToken } = (await login(u.email)).body;
    const res = await post('/api/auth/mfa/verify', undefined, { mfaToken, code: wrongCode(secret) });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid verification code');
  });

  it('replay: the same TOTP time-step cannot be used twice', async () => {
    const u = await makeUser('QA_OPERATOR');
    const { secret } = await enrol(u.email);
    nextStep();
    const c = code(secret);
    const a = (await login(u.email)).body.mfaToken;
    expect((await post('/api/auth/mfa/verify', undefined, { mfaToken: a, code: c })).status).toBe(200);
    const b = (await login(u.email)).body.mfaToken;
    expect((await post('/api/auth/mfa/verify', undefined, { mfaToken: b, code: c })).status).toBe(401);
    nextStep();
    expect((await post('/api/auth/mfa/verify', undefined, { mfaToken: b, code: code(secret) })).status).toBe(200);
  });

  it('locks the user for 15 minutes after 5 failures and audits mfa.locked', async () => {
    const u = await makeUser('QA_OPERATOR');
    const { secret } = await enrol(u.email);
    nextStep();
    const { mfaToken } = (await login(u.email)).body;
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/auth/mfa/verify', undefined, { mfaToken, code: wrongCode(secret) })).status).toBe(401);
    }
    // Even a correct code is refused while locked.
    const locked = await post('/api/auth/mfa/verify', undefined, { mfaToken, code: code(secret) });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('MFA_LOCKED');
    const events = (await getRepositories().audit.query({})).items.map((e) => e.action);
    expect(events).toContain('mfa.locked');
    expect(events.filter((a) => a === 'mfa.verify_failed')).toHaveLength(5);
    // After 15 minutes it works again (fresh login for a fresh mfaToken).
    offsetMs += 16 * 60_000;
    const again = (await login(u.email)).body.mfaToken;
    expect((await post('/api/auth/mfa/verify', undefined, { mfaToken: again, code: code(secret) })).status).toBe(200);
  });

  it('recovery code works exactly once', async () => {
    const u = await makeUser('QA_OPERATOR');
    const { recoveryCodes } = await enrol(u.email);
    nextStep();
    const t1 = (await login(u.email)).body.mfaToken;
    expect((await post('/api/auth/mfa/verify', undefined, { mfaToken: t1, recoveryCode: recoveryCodes[0] })).status).toBe(200);
    const t2 = (await login(u.email)).body.mfaToken;
    expect((await post('/api/auth/mfa/verify', undefined, { mfaToken: t2, recoveryCode: recoveryCodes[0] })).status).toBe(401);
    expect((await post('/api/auth/mfa/verify', undefined, { mfaToken: t2, recoveryCode: recoveryCodes[1].toLowerCase() })).status).toBe(200);
    const st = await get('/api/auth/mfa/status', (await post('/api/auth/mfa/verify', undefined, {
      mfaToken: (await login(u.email)).body.mfaToken, recoveryCode: recoveryCodes[2],
    })).body.token);
    expect(st.body.recoveryCodesRemaining).toBe(7);
  });

  it('users without MFA behave exactly as before', async () => {
    const u = await makeUser('READER_AUDITOR');
    const res = await login(u.email);
    expect(res.body.token).toBeTruthy();
    expect(res.body.mfaRequired).toBeUndefined();
    expect(res.body.mfaEnrollmentRequired).toBeUndefined();
  });
});

describe('disable, regenerate, reset', () => {
  it('disable and regenerate need password AND a valid code', async () => {
    const u = await makeUser('INFRA_ADMIN');
    const { token, secret } = await enrol(u.email);
    nextStep();
    expect((await post('/api/auth/mfa/disable', token, { password: 'nope-nope-nope', code: code(secret) })).status).toBe(401);
    expect((await post('/api/auth/mfa/disable', token, { password: PASSWORD, code: wrongCode(secret) })).status).toBe(401);
    expect((await post('/api/auth/mfa/disable', token, { password: PASSWORD })).status).toBe(400);
    expect((await post('/api/auth/mfa/recovery-codes/regenerate', token, { password: PASSWORD, code: wrongCode(secret) })).status).toBe(401);

    const regen = await post('/api/auth/mfa/recovery-codes/regenerate', token, { password: PASSWORD, code: code(secret) });
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryCodes).toHaveLength(10);
    nextStep();
    expect((await post('/api/auth/mfa/disable', token, { password: PASSWORD, code: code(secret) })).status).toBe(200);
    expect((await get('/api/auth/mfa/status', token)).body.enabled).toBe(false);
    expect((await login(u.email)).body.token).toBeTruthy();
  });

  it('only a Super Admin can reset MFA; the user can then log in and enrol again', async () => {
    const target = await makeUser('QA_OPERATOR');
    await enrol(target.email);
    const other = await makeUser('INFRA_ADMIN');
    const otherToken = (await login(other.email)).body.token;
    expect((await post(`/api/users/${target.id}/mfa/reset`, otherToken)).status).toBe(403);
    expect((await post(`/api/users/${target.id}/mfa/reset`, undefined)).status).toBe(401);

    const admin = await adminToken();
    expect((await post(`/api/users/${target.id}/mfa/reset`, admin)).status).toBe(200);
    const list = await get('/api/users', admin);
    expect(list.body.data.find((x: { id: string }) => x.id === target.id).mfaEnabled).toBe(false);
    nextStep();
    const res = await login(target.email);
    expect(res.body.token).toBeTruthy();
    expect((await post('/api/auth/mfa/enroll/start', res.body.token)).status).toBe(200);
    expect((await getRepositories().audit.query({})).items.map((e) => e.action)).toContain('mfa.reset');
  });

  it('Users list exposes mfaEnabled', async () => {
    const u = await makeUser('QA_OPERATOR');
    await enrol(u.email);
    const list = await get('/api/users', await adminToken());
    expect(list.body.data.find((x: { id: string }) => x.id === u.id).mfaEnabled).toBe(true);
  });
});

describe('policy: MFA_REQUIRED_ROLES', () => {
  it('a required, un-enrolled role gets mfaEnrollmentRequired + a token valid only for enrolment', async () => {
    process.env.MFA_REQUIRED_ROLES = 'INFRA_ADMIN';
    const u = await makeUser('INFRA_ADMIN');
    const res = await login(u.email);
    expect(res.body.mfaEnrollmentRequired).toBe(true);
    expect(res.body.token).toBeUndefined();
    const t = res.body.enrollToken as string;
    expect((await get('/api/dashboard/summary', t)).status).toBe(401);
    expect((await get('/api/auth/me', t)).status).toBe(401);
    expect((await get('/api/auth/mfa/status', t)).body.required).toBe(true);

    const secret = (await post('/api/auth/mfa/enroll/start', t)).body.secret;
    nextStep();
    const confirm = await post('/api/auth/mfa/enroll/confirm', t, { code: code(secret) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    expect((await get('/api/dashboard/summary', confirm.body.session.token)).status).toBe(200);
    // A required role cannot switch MFA off.
    nextStep();
    expect((await post('/api/auth/mfa/disable', confirm.body.session.token, { password: PASSWORD, code: code(secret) })).status).toBe(403);
    // Other roles are unaffected.
    const reader = await makeUser('READER_AUDITOR');
    expect((await login(reader.email)).body.token).toBeTruthy();
  });
});

describe('per-IP rate limit', () => {
  it('limits /auth/mfa/verify to 10 attempts per minute per IP', async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    try {
      let last = 0;
      for (let i = 0; i < 12; i++) {
        last = (await post('/api/auth/mfa/verify', undefined, { mfaToken: 'bad', code: '123456' })).status;
      }
      expect(last).toBe(429);
    } finally {
      process.env.RATE_LIMIT_DISABLED = '1';
    }
  });
});

describe('audit never contains secrets', () => {
  it('records every MFA event and no secret, code, recovery code or token', async () => {
    const u = await makeUser('QA_OPERATOR');
    const { secret, recoveryCodes } = await enrol(u.email);
    nextStep();
    const t = (await login(u.email)).body.mfaToken;
    await post('/api/auth/mfa/verify', undefined, { mfaToken: t, code: wrongCode(secret) });
    await post('/api/auth/mfa/verify', undefined, { mfaToken: t, recoveryCode: recoveryCodes[0] });
    const all = db.prepare('SELECT action, target, metadata FROM audit_events').all() as { action: string; target: string | null; metadata: string | null }[];
    const actions = all.map((e) => e.action);
    for (const a of ['mfa.enroll', 'mfa.verify_failed', 'mfa.recovery_used']) expect(actions).toContain(a);
    const blob = JSON.stringify(all);
    expect(blob).not.toContain(secret);
    for (const c of recoveryCodes) expect(blob).not.toContain(c);
    expect(blob).not.toContain(t);
    expect(blob).not.toContain(code(secret));
  });
});
