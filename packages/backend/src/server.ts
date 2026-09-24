import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { runMigrations } from './db/migrate';

/**
 * Server bootstrap. Applies pending (idempotent, non-destructive) migrations,
 * then starts listening. Seeding and reset are explicit operator actions and are
 * NEVER run here (Part 6).
 *
 * Binds to 0.0.0.0 so the process is reachable from other containers / the
 * reverse proxy; the host it binds to is not a business concern.
 */
function main(): void {
  runMigrations();
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
    // Failsafe: force-exit if connections don't drain in time.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
