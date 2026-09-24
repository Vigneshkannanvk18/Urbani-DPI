import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb, closeDb } from './connection';
import { logger } from '../lib/logger';

/**
 * Minimal forward-only migration runner with schema versioning (Task 1.5).
 *
 * Applies every `NNN_*.sql` file in ./migrations exactly once, in numeric order,
 * inside a transaction, and records applied versions in `schema_migrations`.
 */

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function appliedVersions(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[];
  return new Set(rows.map((r) => r.version));
}

export function runMigrations(db: Database.Database = getDb()): string[] {
  ensureMigrationsTable(db);
  const done = appliedVersions(db);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      );
    });
    tx();
    applied.push(version);
    logger.info('Applied migration', { version });
  }
  return applied;
}

// CLI entry point: `npm run migrate`
if (require.main === module) {
  try {
    const applied = runMigrations();
    if (applied.length === 0) {
      logger.info('No pending migrations; database is up to date');
    } else {
      logger.info('Migrations complete', { count: applied.length });
    }
    closeDb();
  } catch (err) {
    logger.error('Migration failed', { message: (err as Error).message });
    process.exit(1);
  }
}
