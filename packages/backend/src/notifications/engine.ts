import {
  DEFAULT_NOTIFICATION_RULE_ID,
  NOTIFICATION_CHANNELS,
  SEVERITIES,
  type DataSource,
  type NotificationChannelName,
  type NotificationLogEntry,
  type NotificationRule,
  type PersistedAlert,
  type Severity,
} from '@urbani/shared';
import { logger } from '../lib/logger';
import { PersistenceError } from '../lib/errors';
import type { Repositories } from '../repositories/types';
import { DeliveryError, type NotificationChannel } from './channels';
import { redactText } from './guard';
import { logSummary, messageFromAlert, testMessage, type NotificationMessage } from './message';

/**
 * Notification engine (DPI 2 item 6). Given the store's OPEN alerts it evaluates the enabled rules and dispatches
 * through the channel adapters. It runs in-process (see docs/NOTIFICATIONS.md); correctness across several backend
 * tasks rests on the atomic claim in the repository: only the task that wins the claim for (dedupKey, channel) sends.
 * It never creates, changes or fabricates alerts.
 */
export interface EngineOptions {
  dryRun: boolean;
  allowMock: boolean;
  maxAlertAgeMinutes: number;
  baseUrl: string | null;
  now?: () => Date;
}
export interface EngineRunSummary {
  evaluated: number;
  eligible: number;
  log: NotificationLogEntry[];
}

export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

export function ruleMatches(rule: NotificationRule, alert: Pick<PersistedAlert, 'severity' | 'service' | 'anomalyType'>): boolean {
  if (!rule.enabled) return false;
  if (severityRank(alert.severity) < severityRank(rule.minSeverity)) return false;
  if (rule.services.length && !rule.services.includes(alert.service)) return false;
  if (rule.anomalyTypes.length && !rule.anomalyTypes.includes(alert.anomalyType)) return false;
  return true;
}

/** DRAFT default rule (pending client input #7): HIGH and above to every channel that is configured. */
export async function ensureDefaultRule(repos: Repositories): Promise<void> {
  const s = await repos.notifications.getSettings();
  if (s.defaultRuleSeeded) return;
  try {
    await repos.notifications.createRule({
      id: DEFAULT_NOTIFICATION_RULE_ID,
      name: 'Critical and High to all configured channels (DRAFT default)',
      enabled: true,
      minSeverity: 'HIGH',
      services: [],
      anomalyTypes: [],
      channels: [...NOTIFICATION_CHANNELS],
      createdBy: 'system',
    });
  } catch (err) {
    if (!(err instanceof PersistenceError) || err.reason !== 'DUPLICATE') throw err; // another task seeded it first
  }
  await repos.notifications.updateSettings({ defaultRuleSeeded: true }, 'system');
}

export class NotificationEngine {
  constructor(
    private readonly repos: () => Repositories,
    private readonly channels: Record<NotificationChannelName, NotificationChannel>,
    private readonly opts: EngineOptions,
  ) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  /** Evaluates every eligible OPEN alert once. Safe to call concurrently from several tasks. */
  async run(): Promise<EngineRunSummary> {
    const repos = this.repos();
    await ensureDefaultRule(repos);
    const now = this.now();
    const watermark = await repos.notifications.setEngineEnabledAtIfUnset(now.toISOString());
    const rules = (await repos.notifications.listRules()).filter((r) => r.enabled);
    const summary: EngineRunSummary = { evaluated: 0, eligible: 0, log: [] };
    if (rules.length === 0) return summary;
    const settings = await repos.notifications.getSettings();

    const sources: DataSource[] = this.opts.allowMock ? ['LIVE', 'MOCK'] : ['LIVE'];
    const watermarkMs = Date.parse(watermark);
    const maxAgeMs = this.opts.maxAlertAgeMinutes * 60_000;
    for (const dataSource of sources) {
      const { items } = await repos.alerts.query({ status: 'OPEN', dataSource, pageSize: 200 });
      for (const alert of items) {
        summary.evaluated++;
        const ts = Date.parse(alert.timestamp);
        // First run must not blast history: only alerts newer than the watermark or inside the max age qualify.
        if (Number.isNaN(ts) || (ts < watermarkMs && now.getTime() - ts > maxAgeMs)) continue;
        summary.eligible++;
        const byChannel = new Map<NotificationChannelName, string>();
        for (const rule of rules) {
          if (!ruleMatches(rule, alert)) continue;
          for (const ch of rule.channels) if (!byChannel.has(ch)) byChannel.set(ch, rule.id);
        }
        for (const [channel, ruleId] of byChannel) {
          const entry = await this.processAlertChannel(repos, alert, dataSource, channel, ruleId, settings.dedupWindowMinutes, settings.maxPerHourPerChannel);
          if (entry) summary.log.push(entry);
        }
      }
    }
    return summary;
  }

  private async processAlertChannel(
    repos: Repositories,
    alert: PersistedAlert,
    source: DataSource,
    channel: NotificationChannelName,
    ruleId: string,
    dedupMinutes: number,
    maxPerHour: number,
  ): Promise<NotificationLogEntry | null> {
    const base = { alertId: alert.alertId, ruleId, channel, isTest: false };
    // 1. Per alert: each channel is notified once per alert (silent when already done, so polls do not spam the log).
    if (!(await repos.notifications.claim(`alert:${alert.alertId}:OPENED`, channel, null))) return null;
    const message = messageFromAlert(alert, { baseUrl: this.opts.baseUrl, source: source === 'LIVE' ? 'LIVE' : 'MOCK' });
    // 2. Same service + environment + anomaly type inside the dedup window.
    const typeKey = `type:${alert.service}:${alert.environment}:${alert.anomalyType}`;
    if (!(await repos.notifications.claim(typeKey, channel, dedupMinutes * 60_000))) {
      return repos.notifications.appendLog({
        ...base, status: 'SKIPPED_DEDUP', attempts: 0, providerMessageId: null,
        error: `suppressed: same service/anomaly type notified within ${dedupMinutes} min`, summary: logSummary(message),
      });
    }
    // 3. Hourly cap per channel.
    const since = new Date(this.now().getTime() - 3_600_000).toISOString();
    if ((await repos.notifications.countDeliveries(channel, since)) >= maxPerHour) {
      return repos.notifications.appendLog({
        ...base, status: 'SKIPPED_RATE_LIMIT', attempts: 0, providerMessageId: null,
        error: `suppressed (rate limit): ${maxPerHour} per hour reached for ${channel}`, summary: logSummary(message),
      });
    }
    return this.dispatch(repos, channel, message, base);
  }

  /** Sends one clearly labelled test message through the real adapter (or records it as dry-run / not configured). */
  async sendTest(channel: NotificationChannelName, severity: Severity): Promise<NotificationLogEntry> {
    const message = testMessage(severity, this.opts.baseUrl, this.now().toISOString());
    return this.dispatch(this.repos(), channel, message, { alertId: null, ruleId: null, channel, isTest: true });
  }

  private async dispatch(
    repos: Repositories,
    channel: NotificationChannelName,
    message: NotificationMessage,
    base: { alertId: string | null; ruleId: string | null; channel: NotificationChannelName; isTest: boolean },
  ): Promise<NotificationLogEntry> {
    const adapter = this.channels[channel];
    const summary = logSummary(message);
    if (this.opts.dryRun) {
      logger.info('Notification dry-run (not sent)', { channel, alertId: base.alertId, title: message.title, isTest: base.isTest });
      return repos.notifications.appendLog({ ...base, status: 'DRY_RUN', attempts: 0, error: null, providerMessageId: null, summary });
    }
    if (!adapter.isConfigured()) {
      return repos.notifications.appendLog({
        ...base, status: 'SKIPPED_NOT_CONFIGURED', attempts: 0, providerMessageId: null,
        error: 'not delivered: channel not configured', summary,
      });
    }
    try {
      const res = await adapter.send(message);
      return await repos.notifications.appendLog({
        ...base, status: 'SENT', attempts: res.attempts, error: null, providerMessageId: res.providerMessageId, summary,
      });
    } catch (err) {
      const attempts = err instanceof DeliveryError ? err.attempts : 1;
      const error = redactText(err instanceof Error ? err.message : 'delivery failed');
      logger.warn('Notification delivery failed', { channel, alertId: base.alertId, attempts, error });
      return repos.notifications.appendLog({
        ...base, status: 'FAILED', attempts, error, providerMessageId: null, summary,
      });
    }
  }
}
