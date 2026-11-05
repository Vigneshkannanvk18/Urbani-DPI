import type Database from 'better-sqlite3';
import { getDb } from '../../db/connection';
import type { IntegrationRepository, IntegrationRow } from '../types';
import type { SqliteContext } from './index';

/**
 * Integration repository (Epic 12 / Settings), SQLite driver. Tracks non-sensitive
 * config and connection status for each external integration. NEVER stores secrets.
 */

function db(): Database.Database {
  return getDb();
}

export function sqliteIntegrationRepository(_ctx: SqliteContext): IntegrationRepository {
  async function all(): Promise<IntegrationRow[]> {
    return db().prepare('SELECT * FROM integrations ORDER BY kind').all() as IntegrationRow[];
  }

  /** Seed write: INSERT OR REPLACE. */
  async function upsert(row: IntegrationRow): Promise<void> {
    db()
      .prepare(
        `INSERT OR REPLACE INTO integrations (id, kind, display_name, mode, status, config_json, updated_at)
         VALUES (@id, @kind, @display_name, @mode, @status, @config_json, @updated_at)`,
      )
      .run({
        id: row.id,
        kind: row.kind,
        display_name: row.display_name,
        mode: row.mode,
        status: row.status,
        config_json: row.config_json,
        updated_at: row.updated_at,
      });
  }

  /** Seed cleanup of stale rows; deleting a missing id is a no-op. */
  async function deleteById(id: string): Promise<void> {
    db().prepare('DELETE FROM integrations WHERE id = ?').run(id);
  }

  return { all, upsert, delete: deleteById };
}
