import type Database from 'better-sqlite3';
import { getDb } from '../../db/connection';
import { buildAuthUser } from '../common';
import { parseUserRole } from '../validation';
import { DEFAULT_USER_SECURITY, type AuthUser, type RoleRow, type UserRepository, type UserRow, type UserSecurity, type UserUpsert } from '../types';
import type { SqliteContext } from './index';

/**
 * User & Role repository (Data Layer), SQLite driver. Simple role-per-user model —
 * deliberately NOT over-engineered (per the brief: don't over-engineer RBAC).
 * Permissions are stored as a JSON string array on the role for future granularity.
 * users.role (migration 002) is stored only; AuthUser.role still comes from roles.name.
 */

/** Explicit column list: auth/MFA columns (migration 003) are read through getSecurity, never through UserRow. */
const COLS = 'id, email, display_name, password_hash, role_id, is_active, last_login_at, created_at, role';

function db(): Database.Database {
  return getDb();
}

export function sqliteUserRepository(ctx: SqliteContext): UserRepository {
  async function findByEmail(email: string): Promise<UserRow | null> {
    return (
      (db().prepare('SELECT ' + COLS + ' FROM users WHERE email = ? AND is_active = 1').get(email) as
        | UserRow
        | undefined) ?? null
    );
  }

  async function findById(id: string): Promise<UserRow | null> {
    return (
      (db().prepare('SELECT ' + COLS + ' FROM users WHERE id = ? AND is_active = 1').get(id) as
        | UserRow
        | undefined) ?? null
    );
  }

  async function getById(id: string): Promise<UserRow | null> {
    return (db().prepare('SELECT ' + COLS + ' FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  async function list(): Promise<UserRow[]> {
    return db().prepare('SELECT ' + COLS + ' FROM users ORDER BY email').all() as UserRow[];
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

  const SEC_COLS = 'auth_source, mfa_enabled, mfa_secret_encrypted, mfa_enrolled_at, mfa_recovery_hashes, mfa_last_step, mfa_failed_count, mfa_locked_until';
  type SecRow = {
    auth_source: 'local' | 'sso'; mfa_enabled: number; mfa_secret_encrypted: string | null; mfa_enrolled_at: string | null;
    mfa_recovery_hashes: string; mfa_last_step: number | null; mfa_failed_count: number; mfa_locked_until: string | null;
  };
  function toSecurity(r: SecRow): UserSecurity {
    let hashes: string[] = [];
    try { hashes = JSON.parse(r.mfa_recovery_hashes) as string[]; } catch { hashes = []; }
    return {
      authSource: r.auth_source, mfaEnabled: r.mfa_enabled === 1, mfaSecretEncrypted: r.mfa_secret_encrypted,
      mfaEnrolledAt: r.mfa_enrolled_at, mfaRecoveryHashes: hashes, mfaLastStep: r.mfa_last_step,
      mfaFailedCount: r.mfa_failed_count, mfaLockedUntil: r.mfa_locked_until,
    };
  }

  async function getSecurity(id: string): Promise<UserSecurity> {
    const r = db().prepare('SELECT ' + SEC_COLS + ' FROM users WHERE id = ?').get(id) as SecRow | undefined;
    return r ? toSecurity(r) : { ...DEFAULT_USER_SECURITY };
  }

  async function listSecurity(): Promise<Record<string, UserSecurity>> {
    const rows = db().prepare('SELECT id, ' + SEC_COLS + ' FROM users').all() as (SecRow & { id: string })[];
    return Object.fromEntries(rows.map((r) => [r.id, toSecurity(r)]));
  }

  async function updateSecurity(id: string, patch: Partial<UserSecurity>): Promise<void> {
    const cols: Record<string, unknown> = {};
    if (patch.authSource !== undefined) cols.auth_source = patch.authSource;
    if (patch.mfaEnabled !== undefined) cols.mfa_enabled = patch.mfaEnabled ? 1 : 0;
    if (patch.mfaSecretEncrypted !== undefined) cols.mfa_secret_encrypted = patch.mfaSecretEncrypted;
    if (patch.mfaEnrolledAt !== undefined) cols.mfa_enrolled_at = patch.mfaEnrolledAt;
    if (patch.mfaRecoveryHashes !== undefined) cols.mfa_recovery_hashes = JSON.stringify(patch.mfaRecoveryHashes);
    if (patch.mfaLastStep !== undefined) cols.mfa_last_step = patch.mfaLastStep;
    if (patch.mfaFailedCount !== undefined) cols.mfa_failed_count = patch.mfaFailedCount;
    if (patch.mfaLockedUntil !== undefined) cols.mfa_locked_until = patch.mfaLockedUntil;
    const names = Object.keys(cols);
    if (names.length === 0) return;
    db()
      .prepare('UPDATE users SET ' + names.map((n) => n + ' = @' + n).join(', ') + ' WHERE id = @id')
      .run({ ...cols, id });
  }

  async function claimTotpStep(id: string, step: number): Promise<boolean> {
    const res = db()
      .prepare('UPDATE users SET mfa_last_step = ? WHERE id = ? AND (mfa_last_step IS NULL OR mfa_last_step < ?)')
      .run(step, id, step);
    return res.changes > 0;
  }

  async function consumeRecoveryHash(id: string, hash: string): Promise<boolean> {
    // better-sqlite3 is synchronous, so this read-modify-write cannot interleave with another request.
    const r = db().prepare('SELECT mfa_recovery_hashes FROM users WHERE id = ?').get(id) as { mfa_recovery_hashes: string } | undefined;
    if (!r) return false;
    let hashes: string[] = [];
    try { hashes = JSON.parse(r.mfa_recovery_hashes) as string[]; } catch { hashes = []; }
    if (!hashes.includes(hash)) return false;
    db().prepare('UPDATE users SET mfa_recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes.filter((h) => h !== hash)), id);
    return true;
  }

  return { getSecurity, listSecurity, updateSecurity, claimTotpStep, consumeRecoveryHash, findByEmail, findById, getById, list, getRole, toAuthUser, recordLogin, upsertRole, upsertUser };
}
