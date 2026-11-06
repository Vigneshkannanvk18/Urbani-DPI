import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';

/**
 * Migration 002 (DPI 2 persistence foundation) applied to a database that only has 001,
 * as a DPI 1 deployment does today (design §8.3).
 */

const T0 = '2026-10-01T00:00:00.000Z';

function databaseWith001Only(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations', '001_initial_schema.sql'), 'utf8'));
  db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('001_initial_schema', T0);
  return db;
}

describe('migration 002_dpi2_persistence_foundation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = databaseWith001Only();
    db.prepare(
      'INSERT INTO roles (id, name, description, permissions, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('role-admin', 'ADMIN', null, JSON.stringify(['*']), T0);
    db.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role_id, is_active, last_login_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, ?)`,
    ).run('user-1', 'admin@urbani.local', 'Admin', 'not-a-real-hash', 'role-admin', T0);
    const audit = db.prepare(
      `INSERT INTO audit_events (id, timestamp, actor, action, target, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    audit.run('audit-1', '2026-10-01T00:00:01.000Z', 'admin@urbani.local', 'CONFIG_CHANGED', 'chat',
      JSON.stringify({ outcome: 'unavailable' }), T0);
    audit.run('audit-2', '2026-10-01T00:00:02.000Z', 'admin@urbani.local', 'CONFIG_CHANGED', 'chat',
      JSON.stringify({ outcome: 'answered', questionChars: 12 }), T0);
    audit.run('audit-3', '2026-10-01T00:00:03.000Z', 'admin@urbani.local', 'LOGIN', null, null, T0);
  });

  afterEach(() => db.close());

  it('applies once on a 001-only database, backfills role and result, and creates the 4 tables', () => {
    expect(runMigrations(db)).toEqual(['002_dpi2_persistence_foundation', '003_dpi2_mfa_sso', '004_dpi2_notifications', '005_dpi2_chat_meta']);

    expect(db.prepare('SELECT role FROM users WHERE id = ?').get('user-1')).toEqual({ role: 'SUPER_ADMIN' });
    const results = (db.prepare('SELECT result FROM audit_events ORDER BY id').all() as { result: string }[]).map(
      (r) => r.result,
    );
    expect(results).toEqual(['FAILURE', 'SUCCESS', 'SUCCESS']);

    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('user_preferences', 'chat_sessions', 'chat_messages', 'chat_feedback') ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(['chat_feedback', 'chat_messages', 'chat_sessions', 'user_preferences']);

    // Re-running applies nothing.
    expect(runMigrations(db)).toEqual([]);
  });

  it('the users.role CHECK rejects an unknown role', () => {
    runMigrations(db);
    expect(() => db.prepare("UPDATE users SET role = 'BOGUS'").run()).toThrow();
  });
});
