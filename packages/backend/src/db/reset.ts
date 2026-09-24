import { getDb, closeDb } from './connection';
import { config } from '../config';
import { logger } from '../lib/logger';

/**
 * DESTRUCTIVE database reset (Part 6). Drops all application tables so the
 * schema can be rebuilt from scratch. This is a developer convenience ONLY and
 * is NEVER invoked automatically at startup, migration, or seed time.
 *
 * Guard: refuses to run when NODE_ENV=production unless FORCE_DB_RESET=yes is
 * explicitly set, to prevent accidental production data loss.
 */
function reset(): void {
  if (config.isProd && process.env.FORCE_DB_RESET !== 'yes') {
    throw new Error(
      'Refusing to reset the database in production. Set FORCE_DB_RESET=yes to override.',
    );
  }

  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];

  const tx = db.transaction(() => {
    db.pragma('foreign_keys = OFF');
    for (const { name } of tables) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    db.pragma('foreign_keys = ON');
  });
  tx();

  logger.warn('Database reset complete — all tables dropped', { tables: tables.length });
}

if (require.main === module) {
  try {
    reset();
    closeDb();
  } catch (err) {
    logger.error('Database reset failed', { message: (err as Error).message });
    process.exit(1);
  }
}

export { reset };
