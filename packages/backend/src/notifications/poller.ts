import { config } from '../config';
import { logger } from '../lib/logger';

/**
 * Background poller (DPI 2 item 6). In live mode the alerts only reach the store when someone loads the Alerts
 * page, so notifications need their own timer: sync from the Urbani QA API, then run the engine.
 * Never runs in tests; ticks never overlap; the timer is unref'd and stopped on shutdown.
 */
export interface PollerDeps {
  sync: () => Promise<void>;
  run: () => Promise<void>;
  intervalMs: number;
}

export function startPoller(deps: PollerDeps): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // previous tick still in progress
    running = true;
    try {
      await deps.sync();
      await deps.run();
    } catch (err) {
      logger.warn('Notification poll failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Starts the poller when NOTIFICATIONS_ENABLED=true and INTEGRATION_MODE=live (or the mock demo flag); else logs why not. */
export async function startNotificationPoller(): Promise<() => void> {
  if (config.isTest) return () => undefined;
  if (!config.notifications.enabled) {
    logger.info('Notification poller not running (NOTIFICATIONS_ENABLED is not true)');
    return () => undefined;
  }
  const { alertService } = await import('../services/alertService');
  const { runEngineGuarded } = await import('./runtime');
  // Mock mode has nothing to poll; it runs only for demos (NOTIFICATIONS_ALLOW_MOCK=true) against the seeded MOCK alerts.
  if (config.integrationMode !== 'live' && !config.notifications.allowMock) {
    logger.info('Notification poller not running: it needs INTEGRATION_MODE=live (alerts are only polled from the Urbani API)');
    return () => undefined;
  }
  logger.info('Notification poller started', { everyMinutes: config.notifications.pollMinutes, dryRun: config.notifications.dryRun });
  return startPoller({
    sync: () => alertService.sync(),
    run: () => runEngineGuarded(true),
    intervalMs: config.notifications.pollMinutes * 60_000,
  });
}
