import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';

/**
 * User & Role repository (Data Layer). Simple role-per-user model — deliberately
 * NOT over-engineered (per the brief: don't over-engineer RBAC). Permissions are
 * stored as a JSON string array on the role for future granularity.
 */

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string; // JSON array
  created_at: string;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role_id: string;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  permissions: string[];
}

function db(): Database.Database {
  return getDb();
}

export const userRepository = {
  findByEmail(email: string): UserRow | null {
    return (
      (db().prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email) as
        | UserRow
        | undefined) ?? null
    );
  },

  findById(id: string): UserRow | null {
    return (
      (db().prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(id) as
        | UserRow
        | undefined) ?? null
    );
  },

  getRole(roleId: string): RoleRow | null {
    return (
      (db().prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as RoleRow | undefined) ?? null
    );
  },

  toAuthUser(user: UserRow): AuthUser {
    const role = this.getRole(user.role_id);
    let permissions: string[] = [];
    try {
      permissions = role ? (JSON.parse(role.permissions) as string[]) : [];
    } catch {
      permissions = [];
    }
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: role?.name ?? 'UNKNOWN',
      permissions,
    };
  },

  recordLogin(id: string): void {
    db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  },

  upsertRole(row: RoleRow): void {
    db()
      .prepare(
        `INSERT OR REPLACE INTO roles (id, name, description, permissions, created_at)
         VALUES (@id, @name, @description, @permissions, @created_at)`,
      )
      .run(row);
  },

  upsertUser(row: UserRow): void {
    db()
      .prepare(
        `INSERT OR REPLACE INTO users
         (id, email, display_name, password_hash, role_id, is_active, last_login_at, created_at)
         VALUES (@id, @email, @display_name, @password_hash, @role_id, @is_active, @last_login_at, @created_at)`,
      )
      .run(row);
  },
};
