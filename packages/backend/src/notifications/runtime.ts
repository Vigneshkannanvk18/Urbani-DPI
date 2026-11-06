import { SNSClient } from '@aws-sdk/client-sns';
import type { ChannelConfigStatus, NotificationChannelName, NotificationChannelStatus } from '@urbani/shared';
import { config } from '../config';
import { logger } from '../lib/logger';
import { getRepositories } from '../repositories';
import {
  SlackChannel, SnsEmailChannel, TeamsChannel, type FetchLike, type NotificationChannel,
} from './channels';
import { NotificationEngine } from './engine';
import { buildAllowList } from './guard';

/**
 * Wires the engine and channel adapters from config (webhook URLs and the topic ARN are read here and nowhere else).
 * Tests replace the whole runtime with setNotificationRuntimeForTesting.
 */
export interface NotificationRuntime {
  engine: NotificationEngine;
  channels: Record<NotificationChannelName, NotificationChannel>;
  dryRun: boolean;
  /** Status per channel for the API; never contains a URL. */
  channelStatuses(): NotificationChannelStatus[];
}

export function buildRuntime(
  c: typeof config.notifications = config.notifications,
  deps: { fetchImpl?: FetchLike; sns?: ConstructorParameters<typeof SnsEmailChannel>[1] } = {},
): NotificationRuntime {
  const allow = buildAllowList(c.webhookHostAllowlist);
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const sns = deps.sns ?? (c.snsTopicArn ? new SNSClient({ region: config.aws.region }) : null);
  const channels: Record<NotificationChannelName, NotificationChannel> = {
    EMAIL: new SnsEmailChannel(c.snsTopicArn, sns),
    SLACK: new SlackChannel(c.slackWebhookUrl, allow, fetchImpl),
    TEAMS: new TeamsChannel(c.teamsWebhookUrl, allow, fetchImpl, c.teamsFormat),
  };
  const engine = new NotificationEngine(() => getRepositories(), channels, {
    dryRun: c.dryRun, allowMock: c.allowMock, maxAlertAgeMinutes: c.maxAlertAgeMinutes, baseUrl: c.dashboardBaseUrl,
  });
  return {
    engine,
    channels,
    dryRun: c.dryRun,
    channelStatuses() {
      return (['EMAIL', 'SLACK', 'TEAMS'] as const).map((channel) => {
        const s = channels[channel].state();
        const status: ChannelConfigStatus = c.dryRun ? 'DRY_RUN' : s.status;
        return { channel, status, destination: s.destination, reason: s.reason };
      });
    },
  };
}

let runtime: NotificationRuntime | null = null;
export function getNotificationRuntime(): NotificationRuntime {
  return (runtime ??= buildRuntime());
}
export function setNotificationRuntimeForTesting(r: NotificationRuntime | null): void {
  runtime = r;
}

// ---------------------------------------------------------------- guarded runs
let inFlight: Promise<void> | null = null;
let lastRunAt = 0;
const MIN_TRIGGER_INTERVAL_MS = 15_000;

/** Single-flight engine run. `force` ignores the minimum interval (the poller); an overlapping call joins the running one. */
export function runEngineGuarded(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastRunAt < MIN_TRIGGER_INTERVAL_MS) return Promise.resolve();
  lastRunAt = Date.now();
  inFlight = getNotificationRuntime()
    .engine.run()
    .then((s) => {
      if (s.log.length) logger.info('Notification run finished', { evaluated: s.evaluated, eligible: s.eligible, entries: s.log.length });
    })
    .catch((err) => logger.warn('Notification run failed', { error: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Called after a live alert sync inserted alerts: fire-and-forget, harmless when repeated (claims dedup). */
export function triggerEngineAfterSync(): void {
  if (!config.notifications.enabled) return;
  void runEngineGuarded(false);
}
