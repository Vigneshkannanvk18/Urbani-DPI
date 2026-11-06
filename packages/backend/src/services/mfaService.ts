import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { mfaSettings } from '../config/authConfig';
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from '../lib/errors';
import {
  decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp,
} from '../lib/totp';
import { getRepositories, type UserRow, type UserSecurity } from '../repositories';
import { authService, toSessionUser, type LoginResult } from './authService';
import { ConflictError } from './userService';

/**
 * TOTP MFA (DPI 2 item 5). Secrets are AES-256-GCM encrypted at rest, recovery codes stored as hashes
 * only. Nothing secret (secret, code, recovery code) is ever passed to the logger or the audit trail.
 */

export const MFA_MAX_FAILURES = 5;
export const MFA_LOCK_MINUTES = 15;
const GENERIC = 'Invalid verification code';

/** 429: too many failed MFA attempts for this user. */
export class MfaLockedError extends AppError {
  constructor(lockedUntil: string) {
    super('MFA_LOCKED', 'Too many failed attempts. Try again later.', 429, { lockedUntil });
  }
}

export interface MfaCredential {
  code?: string;
  recoveryCode?: string;
}

const now = (): number => Date.now();

async function load(userId: string): Promise<{ user: UserRow; sec: UserSecurity }> {
  const repos = getRepositories();
  const user = await repos.users.findById(userId);
  if (!user) throw new UnauthorizedError('User not found or inactive');
  return { user, sec: await repos.users.getSecurity(userId) };
}

function assertNotLocked(sec: UserSecurity): void {
  if (sec.mfaLockedUntil && Date.parse(sec.mfaLockedUntil) > now()) throw new MfaLockedError(sec.mfaLockedUntil);
}

async function fail(user: UserRow, sec: UserSecurity, reason: string): Promise<never> {
  const repos = getRepositories();
  const count = (sec.mfaFailedCount ?? 0) + 1;
  await repos.audit.record(user.email, 'mfa.verify_failed', user.id, { reason }, 'FAILURE');
  if (count >= MFA_MAX_FAILURES) {
    const lockedUntil = new Date(now() + MFA_LOCK_MINUTES * 60_000).toISOString();
    await repos.users.updateSecurity(user.id, { mfaFailedCount: 0, mfaLockedUntil: lockedUntil });
    await repos.audit.record(user.email, 'mfa.locked', user.id, { lockedUntil, minutes: MFA_LOCK_MINUTES }, 'DENIED');
  } else {
    await repos.users.updateSecurity(user.id, { mfaFailedCount: count });
  }
  throw new UnauthorizedError(GENERIC);
}

/** Checks a TOTP code or a recovery code for an enrolled user. Counts failures and enforces the lockout. */
async function checkCredential(user: UserRow, sec: UserSecurity, cred: MfaCredential): Promise<'totp' | 'recovery'> {
  assertNotLocked(sec);
  const repos = getRepositories();
  if (cred.recoveryCode) {
    if (!(await repos.users.consumeRecoveryHash(user.id, hashRecoveryCode(cred.recoveryCode)))) {
      return fail(user, sec, 'recovery');
    }
    await repos.audit.record(user.email, 'mfa.recovery_used', user.id, {
      remaining: Math.max(0, sec.mfaRecoveryHashes.length - 1),
    });
    return 'recovery';
  }
  if (!cred.code || !sec.mfaSecretEncrypted) return fail(user, sec, 'totp');
  const step = verifyTotp(decryptSecret(sec.mfaSecretEncrypted), cred.code.replace(/\s/g, ''), now());
  if (step === null) return fail(user, sec, 'totp');
  // Replay protection: each time-step is accepted once per user.
  if (!(await repos.users.claimTotpStep(user.id, step))) return fail(user, sec, 'replay');
  return 'totp';
}

async function clearFailures(user: UserRow, sec: UserSecurity): Promise<void> {
  if (sec.mfaFailedCount > 0 || sec.mfaLockedUntil) {
    await getRepositories().users.updateSecurity(user.id, { mfaFailedCount: 0, mfaLockedUntil: null });
  }
}

async function checkPassword(user: UserRow, password: string): Promise<void> {
  if (!(await bcrypt.compare(password, user.password_hash))) throw new UnauthorizedError('Invalid password or verification code');
}

function assertLocal(sec: UserSecurity): void {
  if (sec.authSource === 'sso') throw new ForbiddenError('This account signs in with SSO; MFA is enforced by the identity provider.');
}

function newRecoverySet(): { codes: string[]; hashes: string[] } {
  const codes = generateRecoveryCodes();
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

export const mfaService = {
  async status(userId: string) {
    const { user, sec } = await load(userId);
    return {
      enabled: sec.mfaEnabled,
      enrolledAt: sec.mfaEnrolledAt,
      recoveryCodesRemaining: sec.mfaEnabled ? sec.mfaRecoveryHashes.length : 0,
      required: mfaSettings().requiredRoles.includes(user.role),
      authSource: sec.authSource,
    };
  },

  /** Creates (or replaces) a PENDING secret; MFA is not active until confirm() succeeds. */
  async startEnrol(userId: string) {
    const { user, sec } = await load(userId);
    assertLocal(sec);
    if (sec.mfaEnabled) throw new ConflictError('MFA is already enabled');
    const secret = generateTotpSecret(); // throws in production if MFA_ENCRYPTION_KEY is missing (encryptSecret below)
    await getRepositories().users.updateSecurity(userId, { mfaSecretEncrypted: encryptSecret(secret), mfaEnabled: false });
    const uri = otpauthUri(secret, user.email, mfaSettings().issuer);
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 224 }) };
  },

  /** Returns the 10 recovery codes (shown once) and, if the caller held an enrolment-only token, a full session. */
  async confirmEnrol(userId: string, code: string, issueSession: boolean): Promise<{ recoveryCodes: string[]; session?: LoginResult }> {
    const { user, sec } = await load(userId);
    assertLocal(sec);
    if (sec.mfaEnabled) throw new ConflictError('MFA is already enabled');
    if (!sec.mfaSecretEncrypted) throw new ConflictError('Start enrolment first');
    assertNotLocked(sec);
    const repos = getRepositories();
    const step = verifyTotp(decryptSecret(sec.mfaSecretEncrypted), code.replace(/\s/g, ''), now());
    if (step === null) return fail(user, sec, 'enrol');
    const { codes, hashes } = newRecoverySet();
    await repos.users.updateSecurity(userId, {
      mfaEnabled: true, mfaEnrolledAt: new Date().toISOString(), mfaRecoveryHashes: hashes, mfaLastStep: step,
      mfaFailedCount: 0, mfaLockedUntil: null,
    });
    await repos.audit.record(user.email, 'mfa.enroll', user.id, { recoveryCodes: codes.length });
    return { recoveryCodes: codes, ...(issueSession ? { session: await authService.issueSession(user) } : {}) };
  },

  /** Second login step. Wrong credential => 401 with a generic message; lockout => 429. */
  async verifyLogin(mfaToken: string, cred: MfaCredential): Promise<LoginResult> {
    const payload = authService.verifyScoped(mfaToken, 'mfa');
    const { user, sec } = await load(payload.sub);
    if (!sec.mfaEnabled) throw new UnauthorizedError(GENERIC);
    const kind = await checkCredential(user, sec, cred);
    await clearFailures(user, sec);
    await getRepositories().audit.record(user.email, 'mfa.verify_success', user.id, { method: kind });
    return authService.issueSession(user, { mfa: kind });
  },

  async disable(userId: string, password: string, cred: MfaCredential): Promise<void> {
    const { user, sec } = await load(userId);
    if (!sec.mfaEnabled) throw new ConflictError('MFA is not enabled');
    if (mfaSettings().requiredRoles.includes(user.role)) throw new ForbiddenError('MFA is required for your role and cannot be disabled');
    await checkPassword(user, password);
    await checkCredential(user, sec, cred);
    await getRepositories().users.updateSecurity(userId, {
      mfaEnabled: false, mfaSecretEncrypted: null, mfaEnrolledAt: null, mfaRecoveryHashes: [], mfaLastStep: null,
      mfaFailedCount: 0, mfaLockedUntil: null,
    });
    await getRepositories().audit.record(user.email, 'mfa.disable', user.id);
  },

  async regenerateRecoveryCodes(userId: string, password: string, cred: MfaCredential): Promise<string[]> {
    const { user, sec } = await load(userId);
    if (!sec.mfaEnabled) throw new ConflictError('MFA is not enabled');
    await checkPassword(user, password);
    await checkCredential(user, sec, cred);
    const { codes, hashes } = newRecoverySet();
    await getRepositories().users.updateSecurity(userId, { mfaRecoveryHashes: hashes, mfaFailedCount: 0, mfaLockedUntil: null });
    await getRepositories().audit.record(user.email, 'mfa.recovery_regenerate', user.id, { recoveryCodes: codes.length });
    return codes;
  },

  /** Super Admin: clears MFA so a locked-out user can enrol again. Route requires users:manage. */
  async reset(actorEmail: string, userId: string): Promise<void> {
    const repos = getRepositories();
    const user = await repos.users.getById(userId);
    if (!user) throw new NotFoundError('User not found');
    await repos.users.updateSecurity(userId, {
      mfaEnabled: false, mfaSecretEncrypted: null, mfaEnrolledAt: null, mfaRecoveryHashes: [], mfaLastStep: null,
      mfaFailedCount: 0, mfaLockedUntil: null,
    });
    await repos.audit.record(actorEmail, 'mfa.reset', userId, { email: user.email });
  },

  async sessionUser(userId: string) {
    return toSessionUser((await load(userId)).user);
  },
};
