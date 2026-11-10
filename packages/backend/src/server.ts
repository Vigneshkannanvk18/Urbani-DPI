import { createApp } from './app';
import { startAuditRetentionJob } from './services/auditService';
import { startNotificationRetentionJob } from './services/notificationService';
import { startChatRetentionJob } from './services/chatHistoryService';
import { startHealthProbes, startHealthRetentionJob } from './services/healthService';
import { startNotificationPoller } from './notifications/poller';
import { config } from './config';
import { logger } from './lib/logger';
import { runMigrations } from './db/migrate';
import { getRepositories, assertDynamoReachable } from './repositories';

/**
 * Server bootstrap. Selects the persistence driver (DB_DRIVER), applies pending
 * (idempotent, non-destructive) SQLite migrations or probes DynamoDB, then starts
 * listening. Seeding and reset are explicit operator actions and are NEVER run
 * here (Part 6).
 *
 * Binds to 0.0.0.0 so the process is reachable from other containers / the
 * reverse proxy; the host it binds to is not a business concern.
 */
async function main(): Promise<void> {
  const repos = getRepositories();
  if (repos.driver === 'sqlite') {
    runMigrations();
  } else {
    await assertDynamoReachable(repos);
  }
  const app = createApp();
  startAuditRetentionJob();
startChatRetentionJob();
  startNotificationRetentionJob();
  startHealthRetentionJob();
  const stopHealthProbes = startHealthProbes();
  const stopPoller = await startNotificationPoller();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info('Urbani Observability API listening', {
      port: config.port,
      env: config.env,
      integrationMode: config.integrationMode,
      dbDriver: repos.driver,
    });
  });

  // Behind an ALB (default idle timeout 60 s) Node's 5 s keep-alive timeout closes idle sockets first and the
  // ALB then reuses a dead connection (intermittent 502). Keep ours above the ALB's; headersTimeout must exceed it.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Graceful shutdown for container orchestration (SIGTERM from Docker/K8s).
  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    stopPoller();
    stopHealthProbes();
    server.close(() => process.exit(0));
    // Failsafe: force-exit if connections don't drain in time.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Startup failed', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
