import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { permissionsForRole, ROLE_DISPLAY_NAMES, type UserRole } from '@urbani/shared';
import { config } from '../config';
import { UnauthorizedError } from '../lib/errors';
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
}

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

async function toSessionUser(row: UserRow): Promise<SessionUser> {
  const base = await getRepositories().users.toAuthUser(row);
  return {
    ...base,
    rbacRole: row.role,
    rbacRoleName: ROLE_DISPLAY_NAMES[row.role],
    permissions: permissionsForRole(row.role),
  };
}

export const authService = {
  async login(email: string, password: string): Promise<LoginResult> {
    const repos = getRepositories();
    // findByEmail returns active users only, so a deactivated user cannot log in.
    const user = await repos.users.findByEmail(email);
    // Constant-ish behaviour: always run a compare to reduce user-enumeration signal.
    const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) {
      await repos.audit.record(email, 'auth.login_failed', undefined, undefined, 'FAILURE');
      throw new UnauthorizedError('Invalid email or password');
    }
    await repos.users.recordLogin(user.id);
    const authUser = await toSessionUser(user);
    await repos.audit.record(user.email, 'LOGIN');
    const payload: TokenPayload = { sub: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, config.auth.jwtSecret, {
      expiresIn: config.auth.jwtExpiresIn,
    } as jwt.SignOptions);
    return { token, user: authUser };
  },

  verify(token: string): TokenPayload {
    try {
      return jwt.verify(token, config.auth.jwtSecret) as TokenPayload;
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
