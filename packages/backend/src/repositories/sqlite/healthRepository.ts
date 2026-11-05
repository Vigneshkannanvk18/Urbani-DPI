import { getDb } from '../../db/connection';
import type { HealthRepository } from '../types';
import type { SqliteContext } from './index';

/** Readiness probe (GET /ready), SQLite driver: a trivial query confirms the connection is usable. */
export function sqliteHealthRepository(_ctx: SqliteContext): HealthRepository {
  async function ping(): Promise<void> {
    getDb().prepare('SELECT 1').get();
  }

  return { ping };
}
