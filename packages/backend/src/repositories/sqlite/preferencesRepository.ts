import type Database from 'better-sqlite3';
import type { Theme } from '@urbani/shared';
import { getDb } from '../../db/connection';
import { PersistenceError } from '../../lib/errors';
import { parsePreferencesPatch, parseReadId } from '../validation';
import type { PreferencesPatch, PreferencesRepository, UserPreferences } from '../types';
import type { SqliteContext } from './index';

/**
 * User preferences (DPI 2 item 1), SQLite driver. One row per user. user_id has no
 * foreign key (migration 002), so the user check is explicit: a user exists when a
 * users row with that id exists, whatever is_active is.
 */

interface PreferencesRow {
  user_id: string;
  theme: string | null;
  widget_layout_json: string | null;
  updated_at: string;
}

function db(): Database.Database {
  return getDb();
}

function rowToPreferences(row: PreferencesRow): UserPreferences {
  return {
    userId: row.user_id,
    theme: row.theme as Theme | null,
    widgetLayout: row.widget_layout_json === null ? null : (JSON.parse(row.widget_layout_json) as unknown),
    updatedAt: row.updated_at,
  };
}

export function sqlitePreferencesRepository(ctx: SqliteContext): PreferencesRepository {
  async function get(userId: string): Promise<UserPreferences | null> {
    const id = parseReadId(userId);
    const row = db().prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(id) as
      | PreferencesRow
      | undefined;
    return row ? rowToPreferences(row) : null;
  }

  /** Validates the patch, then checks the user, merges and writes in one transaction. */
  async function update(userId: string, patch: PreferencesPatch): Promise<UserPreferences> {
    const p = parsePreferencesPatch(userId, patch);
    const now = ctx.now();
    const tx = db().transaction((): PreferencesRow => {
      if (!db().prepare('SELECT 1 FROM users WHERE id = ?').get(p.userId)) {
        throw new PersistenceError('REFERENCE_NOT_FOUND', 'Referenced record not found');
      }
      const current = db().prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(p.userId) as
        | PreferencesRow
        | undefined;
      // undefined keeps the stored value, null clears it.
      let layoutJson = current?.widget_layout_json ?? null;
      if (p.widgetLayout !== undefined) {
        layoutJson = p.widgetLayout === null ? null : JSON.stringify(p.widgetLayout);
      }
      const next: PreferencesRow = {
        user_id: p.userId,
        theme: p.theme !== undefined ? p.theme : (current?.theme ?? null),
        widget_layout_json: layoutJson,
        updated_at: now,
      };
      db()
        .prepare(
          `INSERT INTO user_preferences (user_id, theme, widget_layout_json, updated_at)
           VALUES (@user_id, @theme, @widget_layout_json, @updated_at)
           ON CONFLICT(user_id) DO UPDATE SET
             theme = excluded.theme, widget_layout_json = excluded.widget_layout_json,
             updated_at = excluded.updated_at`,
        )
        .run(next);
      return next;
    });
    return rowToPreferences(tx());
  }

  return { get, update };
}
