import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config';

/**
 * SQLite connection (Phase 1). The repository layer is the ONLY consumer of this
 * module, keeping the storage engine swappable for a DynamoDB adapter in Phase 2
 * without touching services or the dashboard.
 */

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = config.db.sqlitePath;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Used by tests to run against an isolated in-memory database. */
export function setDbForTesting(instance: Database.Database): void {
  db = instance;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
