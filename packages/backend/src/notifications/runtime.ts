import { SNSClient } from '@aws-sdk/client-sns';
import nodemailer from 'nodemailer';
import type { ChannelConfigStatus, NotificationChannelName, NotificationChannelStatus } from '@urbani/shared';
import { config } from '../config';
import { logger } from '../lib/logger';
import { getRepositories } from '../repositories';
import {
  SlackChannel, SmtpEmailChannel, SnsEmailChannel, TeamsChannel, type FetchLike, type MailTransportLike, type NotificationChannel,
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
  deps: { fetchImpl?: FetchLike; sns?: ConstructorParameters<typeof SnsEmailChannel>[1]; mailTransport?: MailTransportLike } = {},
): NotificationRuntime {
  const allow = buildAllowList(c.webhookHostAllowlist);
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const sns = deps.sns ?? (c.snsTopicArn ? new SNSClient({ region: config.aws.region }) : null);
  // SMTP (Google Workspace) wins over SNS when SMTP_HOST is set; otherwise e-mail keeps going through SNS.
  const smtp = c.smtp;
  const mailTransport: MailTransportLike | null =
    deps.mailTransport ??
    (smtp.host
      ? nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          requireTLS: !smtp.secure,
          auth: smtp.user && smtp.password ? { user: smtp.user, pass: smtp.password } : undefined,
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 15_000,
        })
      : null);
  const channels: Record<NotificationChannelName, NotificationChannel> = {
    EMAIL: smtp.host
      ? new SmtpEmailChannel(
          {
            host: smtp.host, from: smtp.from, to: smtp.to, user: smtp.user, password: smtp.password,
            toRoles: smtp.toRoles,
            // Active users of the configured roles, read from the Users table on every send (so role changes apply at once).
            resolveRoleRecipients: async (roles) =>
              (await getRepositories().users.list()).filter((u) => u.is_active === 1 && roles.includes(u.role)).map((u) => u.email),
          },
          mailTransport,
        )
      : new SnsEmailChannel(c.snsTopicArn, sns),
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
