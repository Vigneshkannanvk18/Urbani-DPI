import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { permissionsForRole, ROLE_DISPLAY_NAMES, type UserRole } from '@urbani/shared';
import { config } from '../config';
import { setAuditActor } from '../lib/auditMetadata';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';
import { mfaSettings, ssoSettings } from '../config/authConfig';
import { getRepositories, type AuthUser, type UserRow } from '../repositories';

/**
 * Authentication service (Service Layer, Epic 2).
 *
 * JWT-based stateless sessions. Passwords are bcrypt-hashed. Logout is recorded
 * for audit. The JWT carries the role for information only: every request
 * re-loads the active user (requireAuth), so role changes and deactivation take
 * effect immediately (DPI 2 item 2).
 */

export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
  /** Absent on full session tokens. 'mfa' (5 min, only /auth/mfa/verify) and 'mfa_enroll' (enrolment endpoints only) are scoped tokens. */
  purpose?: ScopedPurpose;
}

export type ScopedPurpose = 'mfa' | 'mfa_enroll';
const SCOPED_TTL: Record<ScopedPurpose, string> = { mfa: '5m', mfa_enroll: '15m' };

/**
 * AuthUser.role is the legacy `roles` table label. The RBAC role (DPI 2 item 2) is `rbacRole`,
 * and `permissions` is the effective list from the shared (DRAFT) matrix.
 */
export interface SessionUser extends AuthUser {
  rbacRole: UserRole;
  rbacRoleName: string;
}

export interface LoginResult {
  token: string;
  user: SessionUser;
}

/** Password accepted but a second step is needed (user has MFA). No session token. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

/** Policy requires MFA and the user has none: only the enrolment endpoints accept this token. */
export interface MfaEnrollmentRequired {
  mfaEnrollmentRequired: true;
  enrollToken: string;
  user: SessionUser;
}

export async function toSessionUser(row: UserRow): Promise<SessionUser> {
  const base = await getRepositories().users.toAuthUser(row);
  return {
    ...base,
    rbacRole: row.role,
    rbacRoleName: ROLE_DISPLAY_NAMES[row.role],
    permissions: permissionsForRole(row.role),
  };
}

export const authService = {
  async login(email: string, password: string): Promise<LoginResult | MfaChallenge | MfaEnrollmentRequired> {
    const repos = getRepositories();
    if (!ssoSettings().localEnabled) {
      throw new ForbiddenError('Local sign-in is disabled. Use single sign-on.');
    }
    // findByEmail returns active users only, so a deactivated user cannot log in.
    const user = await repos.users.findByEmail(email);
    const security = user ? await repos.users.getSecurity(user.id) : null;
    // SSO users have no usable local password.
    const hash = user && security?.authSource !== 'sso' ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva';
    // Constant-ish behaviour: always run a compare to reduce user-enumeration signal.
    const ok = await bcrypt.compare(password, hash);
    if (!user || !security || !ok) {
      await repos.audit.record(email, 'auth.login_failed', undefined, undefined, 'FAILURE');
      throw new UnauthorizedError('Invalid email or password');
    }
    if (security.mfaEnabled) {
      return { mfaRequired: true, mfaToken: authService.signScoped(user, 'mfa') };
    }
    if (mfaSettings().requiredRoles.includes(user.role)) {
      setAuditActor({ userId: user.id, email: user.email, role: user.role });
      await repos.audit.record(user.email, 'LOGIN', undefined, { mfaEnrollmentRequired: true });
      return { mfaEnrollmentRequired: true, enrollToken: authService.signScoped(user, 'mfa_enroll'), user: await toSessionUser(user) };
    }
    return authService.issueSession(user);
  },

  /** Records the login, audits it and signs the normal session JWT. */
  async issueSession(user: UserRow, auditMeta?: Record<string, unknown>): Promise<LoginResult> {
    const repos = getRepositories();
    await repos.users.recordLogin(user.id);
    const authUser = await toSessionUser(user);
    setAuditActor({ userId: user.id, email: user.email, role: user.role });
    await repos.audit.record(user.email, 'LOGIN', undefined, auditMeta);
    const payload: TokenPayload = { sub: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, config.auth.jwtSecret, {
      expiresIn: config.auth.jwtExpiresIn,
    } as jwt.SignOptions);
    return { token, user: authUser };
  },

  signScoped(user: UserRow, purpose: ScopedPurpose): string {
    const payload: TokenPayload = { sub: user.id, email: user.email, role: user.role, purpose };
    return jwt.sign(payload, config.auth.jwtSecret, { expiresIn: SCOPED_TTL[purpose] } as jwt.SignOptions);
  },

  /** Verifies a purpose-scoped token; a session token or a token of another purpose is rejected. */
  verifyScoped(token: string, purpose: ScopedPurpose): TokenPayload {
    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, config.auth.jwtSecret) as TokenPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
    if (payload.purpose !== purpose) throw new UnauthorizedError('Invalid or expired token');
    return payload;
  },

  /** Any valid token, session or scoped (callers decide which purposes they accept). */
  decode(token: string): TokenPayload {
    try {
      return jwt.verify(token, config.auth.jwtSecret) as TokenPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
  },
  verify(token: string): TokenPayload {
    try {
      const payload = jwt.verify(token, config.auth.jwtSecret) as TokenPayload;
      // Scoped tokens (MFA step / enrolment) never act as a session.
      if (payload.purpose) throw new Error('scoped token');
      return payload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
  },

  /** Active user row for a token subject; 401 if missing or deactivated (per-request check). */
  async activeUser(userId: string): Promise<UserRow> {
    const user = await getRepositories().users.findById(userId);
    if (!user) throw new UnauthorizedError('User not found or inactive');
    return user;
  },

  async me(userId: string): Promise<SessionUser> {
    return toSessionUser(await authService.activeUser(userId));
  },

  async logout(email: string): Promise<void> {
    const repos = getRepositories();
    await repos.audit.record(email, 'LOGOUT');
  },
};
