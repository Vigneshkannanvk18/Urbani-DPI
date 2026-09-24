import Database from 'better-sqlite3';
import { setDbForTesting } from '../db/connection';
import { runMigrations } from '../db/migrate';

/**
 * Creates a fresh in-memory database, runs migrations, and wires it as the
 * process-wide connection used by repositories. Returns the instance so tests
 * can close it.
 */
export function freshTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  setDbForTesting(db);
  runMigrations(db);
  return db;
}
