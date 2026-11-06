import type Database from 'better-sqlite3';
import { getDb } from '../../db/connection';
import { buildAuthUser } from '../common';
import { parseUserRole } from '../validation';
import type { AuthUser, RoleRow, UserRepository, UserRow, UserUpsert } from '../types';
import type { SqliteContext } from './index';

/**
 * User & Role repository (Data Layer), SQLite driver. Simple role-per-user model —
 * deliberately NOT over-engineered (per the brief: don't over-engineer RBAC).
 * Permissions are stored as a JSON string array on the role for future granularity.
 * users.role (migration 002) is stored only; AuthUser.role still comes from roles.name.
 */

function db(): Database.Database {
  return getDb();
}

export function sqliteUserRepository(ctx: SqliteContext): UserRepository {
  async function findByEmail(email: string): Promise<UserRow | null> {
    return (
      (db().prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email) as
        | UserRow
        | undefined) ?? null
    );
  }

  async function findById(id: string): Promise<UserRow | null> {
    return (
      (db().prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(id) as
        | UserRow
        | undefined) ?? null
    );
  }

  async function getById(id: string): Promise<UserRow | null> {
    return (db().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  async function list(): Promise<UserRow[]> {
    return db().prepare('SELECT * FROM users ORDER BY email').all() as UserRow[];
  }

  function getRoleSync(roleId: string): RoleRow | null {
    return (
      (db().prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as RoleRow | undefined) ?? null
    );
  }

  async function getRole(roleId: string): Promise<RoleRow | null> {
    return getRoleSync(roleId);
  }

  async function toAuthUser(user: UserRow): Promise<AuthUser> {
    return buildAuthUser(user, getRoleSync(user.role_id));
  }

  async function recordLogin(id: string): Promise<void> {
    db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ctx.now(), id);
  }

  async function upsertRole(row: RoleRow): Promise<void> {
    db()
      .prepare(
        `INSERT OR REPLACE INTO roles (id, name, description, permissions, created_at)
         VALUES (@id, @name, @description, @permissions, @created_at)`,
      )
      .run(row);
  }

  /**
   * Same-id upsert (design §4.3). A new user defaults to SUPER_ADMIN, an omitted role
   * keeps the stored one, and an email owned by another user fails with the UNIQUE
   * error instead of replacing that user.
   */
  async function upsertUser(row: UserUpsert): Promise<void> {
    const role = parseUserRole(row.role);
    db()
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role_id, is_active, last_login_at, created_at, role)
         VALUES (@id, @email, @display_name, @password_hash, @role_id, @is_active, @last_login_at, @created_at, COALESCE(@role, 'SUPER_ADMIN'))
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email, display_name = excluded.display_name, password_hash = excluded.password_hash,
           role_id = excluded.role_id, is_active = excluded.is_active, last_login_at = excluded.last_login_at,
           created_at = excluded.created_at, role = COALESCE(@role, users.role)`,
      )
      .run({
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        password_hash: row.password_hash,
        role_id: row.role_id,
        is_active: row.is_active,
        last_login_at: row.last_login_at,
        created_at: row.created_at,
        role,
      });
  }

  return { findByEmail, findById, getById, list, getRole, toAuthUser, recordLogin, upsertRole, upsertUser };
}
