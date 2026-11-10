import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { runMigrations } from './db/migrate';
import { getDb } from './db/connection';
import { seed } from './db/seed';

/**
 * Server bootstrap. Applies pending migrations, auto-seeds on first boot
 * (empty users table = fresh Fargate volume), then starts listening.
 */
async function main(): Promise<void> {
  runMigrations();

  // Auto-seed when the database is empty (fresh Fargate ephemeral volume).
  // Safe to run on every cold start — seed() is idempotent and skips existing rows.
  const userCount = (getDb().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n;
  if (userCount === 0) {
    logger.info('Empty database detected — running first-boot seed...');
    process.env.FORCE_DB_SEED = 'yes';
    await seed();
  }
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info('Urbani Observability API listening', {
      port: config.port,
      env: config.env,
      integrationMode: config.integrationMode,
    });
  });

  // Graceful shutdown for container orchestration (SIGTERM from Docker/K8s).
  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
