import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ROLE_DISPLAY_NAMES, type UserRole } from '@urbani/shared';
import { AppError, NotFoundError } from '../lib/errors';
import { getRepositories, type UserRow } from '../repositories';

/**
 * User management (DPI 2 item 2). Callers must already hold `users:manage`
 * (enforced by the route). Every change is audited.
 */

export const MIN_PASSWORD_LENGTH = 10;

/** 409: the request is valid but conflicts with a guard rail or existing data. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

export interface UserView {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  roleName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** DPI 2 item 5 */
  mfaEnabled: boolean;
  authSource: 'local' | 'sso';
}

function view(u: UserRow, sec?: { mfaEnabled: boolean; authSource: 'local' | 'sso' }): UserView {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    roleName: ROLE_DISPLAY_NAMES[u.role],
    isActive: u.is_active === 1,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    mfaEnabled: sec?.mfaEnabled ?? false,
    authSource: sec?.authSource ?? 'local',
  };
}

/** Legacy `roles` table label kept coherent with the RBAC role (FK target for users.role_id). */
export function legacyRoleId(role: UserRole): string {
  return role === 'SUPER_ADMIN' || role === 'INFRA_ADMIN' ? 'role-admin' : 'role-viewer';
}

export async function ensureLegacyRole(roleId: string): Promise<void> {
  const repos = getRepositories();
  if (await repos.users.getRole(roleId)) return;
  const admin = roleId === 'role-admin';
  await repos.users.upsertRole({
    id: roleId,
    name: admin ? 'ADMIN' : 'VIEWER',
    description: admin ? 'Administrative access' : 'Read-only access',
    permissions: JSON.stringify(admin ? ['*'] : ['read']),
    created_at: new Date().toISOString(),
  });
}

async function load(id: string): Promise<UserRow> {
  const user = await getRepositories().users.getById(id);
  if (!user) throw new NotFoundError('User not found');
  return user;
}

async function activeSuperAdminCount(): Promise<number> {
  return (await getRepositories().users.list()).filter((u) => u.role === 'SUPER_ADMIN' && u.is_active === 1).length;
}

async function assertNotLastSuperAdmin(target: UserRow, action: string): Promise<void> {
  if (target.role === 'SUPER_ADMIN' && target.is_active === 1 && (await activeSuperAdminCount()) <= 1) {
    throw new ConflictError(`Cannot ${action} the last active Super Admin`);
  }
}

export const userService = {
  async list(): Promise<UserView[]> {
    const repos = getRepositories();
    const [users, sec] = await Promise.all([repos.users.list(), repos.users.listSecurity()]);
    return users.map((u) => view(u, sec[u.id]));
  },

  async create(
    actor: string,
    input: { email: string; displayName: string; role: UserRole; password: string },
  ): Promise<UserView> {
    const repos = getRepositories();
    const email = input.email.trim().toLowerCase();
    if ((await repos.users.list()).some((u) => u.email.toLowerCase() === email)) {
      throw new ConflictError('A user with this email already exists');
    }
    const roleId = legacyRoleId(input.role);
    await ensureLegacyRole(roleId);
    const row: UserRow = {
      id: randomUUID(),
      email,
      display_name: input.displayName.trim(),
      password_hash: await bcrypt.hash(input.password, 10),
      role_id: roleId,
      is_active: 1,
      last_login_at: null,
      created_at: new Date().toISOString(),
      role: input.role,
    };
    await repos.users.upsertUser(row);
    await repos.audit.record(actor, 'user.create', row.id, { email, role: input.role });
    return view(row);
  },

  async changeRole(actor: { id: string; email: string }, id: string, role: UserRole): Promise<UserView> {
    const repos = getRepositories();
    if (id === actor.id) throw new ConflictError('You cannot change your own role');
    const user = await load(id);
    if (user.role === role) return view(user);
    if (role !== 'SUPER_ADMIN') await assertNotLastSuperAdmin(user, 'demote');
    const roleId = legacyRoleId(role);
    await ensureLegacyRole(roleId);
    const updated: UserRow = { ...user, role, role_id: roleId };
    await repos.users.upsertUser(updated);
    await repos.audit.record(actor.email, 'user.role_change', id, { email: user.email, from: user.role, to: role });
    return view(updated);
  },

  async setActive(actor: { id: string; email: string }, id: string, active: boolean): Promise<UserView> {
    const repos = getRepositories();
    const user = await load(id);
    if (!active) {
      if (id === actor.id) throw new ConflictError('You cannot deactivate your own account');
      await assertNotLastSuperAdmin(user, 'deactivate');
    }
    const updated: UserRow = { ...user, is_active: active ? 1 : 0 };
    await repos.users.upsertUser(updated);
    await repos.audit.record(actor.email, active ? 'user.activate' : 'user.deactivate', id, { email: user.email });
    return view(updated);
  },

  async resetPassword(actor: string, id: string, password: string): Promise<void> {
    const repos = getRepositories();
    const user = await load(id);
    await repos.users.upsertUser({ ...user, password_hash: await bcrypt.hash(password, 10) });
    await repos.audit.record(actor, 'user.password_reset', id, { email: user.email });
  },
};
