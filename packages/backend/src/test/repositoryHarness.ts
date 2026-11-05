import type Database from 'better-sqlite3';
import { createSqliteRepositories } from '../repositories/sqlite';
import type { Repositories } from '../repositories/types';
import { freshTestDb } from './testDb';

/**
 * Drives the repository contract suite (design §8.1) against one driver. Each test gets an
 * empty store and repositories bound to its own clock. The DynamoDB harness is added with the
 * DynamoDB Local tooling.
 */
export interface RepositoryHarness {
  readonly name: 'sqlite' | 'dynamodb';
  /** beforeAll (timeout 60 s). */
  setupSuite(): Promise<void>;
  /** beforeEach: empty store + repositories bound to the clock. */
  fresh(now: () => string): Promise<Repositories>;
  /** afterEach. */
  cleanup(): Promise<void>;
  /** afterAll. */
  teardownSuite(): Promise<void>;
}

/** SQLite: fresh = freshTestDb() + createSqliteRepositories({ now }); cleanup closes that database. */
export function sqliteHarness(): RepositoryHarness {
  let db: Database.Database | null = null;
  return {
    name: 'sqlite',
    async setupSuite() {},
    async fresh(now) {
      db = freshTestDb();
      return createSqliteRepositories({ now });
    },
    async cleanup() {
      db?.close();
      db = null;
    },
    async teardownSuite() {},
  };
}

/** A strictly increasing clock: startIso, startIso + stepMs, … (ISO-8601 UTC with milliseconds). */
export function makeTestClock(startIso = '2026-10-01T00:00:00.000Z', stepMs = 1000): () => string {
  let next = Date.parse(startIso);
  return () => {
    const value = new Date(next).toISOString();
    next += stepMs;
    return value;
  };
}
