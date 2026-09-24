import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';

/**
 * Integration repository (Epic 12 / Settings). Tracks non-sensitive config and
 * connection status for each external integration. NEVER stores secrets.
 */

export interface IntegrationRow {
  id: string;
  kind: string;
  display_name: string;
  mode: string;
  status: string;
  config_json: string;
  updated_at: string;
}

function db(): Database.Database {
  return getDb();
}

export const integrationRepository = {
  all(): IntegrationRow[] {
    return db().prepare('SELECT * FROM integrations ORDER BY kind').all() as IntegrationRow[];
  },
};
