import type {
  NotificationChannelName, NotificationChannelStatus, NotificationLogEntry, NotificationRule, Severity,
} from '@urbani/shared';
import { config } from '../config';
import { NotFoundError, ValidationError } from '../lib/errors';
import { SnsEmailChannel, type SnsConnectionCheck } from '../notifications/channels';
import { logger } from '../lib/logger';
import { ensureDefaultRule } from '../notifications/engine';
import { getNotificationRuntime } from '../notifications/runtime';
import { getRepositories } from '../repositories';
import type {
  NewNotificationRule, NotificationLogQuery, NotificationRulePatch, NotificationSettingsPatch, PageResult,
} from '../repositories/types';

/** Rules, settings, delivery log and test-send (DPI 2 item 6). Every mutation is audited. */
export const notificationService = {
  channels(): NotificationChannelStatus[] {
    return getNotificationRuntime().channelStatuses();
  },

  async listRules(): Promise<NotificationRule[]> {
    const repos = getRepositories();
    await ensureDefaultRule(repos);
    return repos.notifications.listRules();
  },

  async createRule(actor: string, input: Omit<NewNotificationRule, 'createdBy' | 'id'>): Promise<NotificationRule> {
    const repos = getRepositories();
    const rule = await repos.notifications.createRule({ ...input, createdBy: actor });
    await repos.audit.record(actor, 'notification.rule_create', rule.id, {
      name: rule.name, enabled: rule.enabled, minSeverity: rule.minSeverity, services: rule.services,
      anomalyTypes: rule.anomalyTypes, channels: rule.channels,
    });
    return rule;
  },

  async updateRule(actor: string, id: string, patch: NotificationRulePatch): Promise<NotificationRule> {
    const repos = getRepositories();
    const rule = await repos.notifications.updateRule(id, patch, actor);
    if (!rule) throw new NotFoundError(`Notification rule not found: ${id}`);
    await repos.audit.record(actor, 'notification.rule_update', id, { changed: patch });
    return rule;
  },

  async deleteRule(actor: string, id: string): Promise<void> {
    const repos = getRepositories();
    if (!(await repos.notifications.deleteRule(id))) throw new NotFoundError(`Notification rule not found: ${id}`);
    await repos.audit.record(actor, 'notification.rule_delete', id);
  },

  async getSettings() {
    const { dedupWindowMinutes, maxPerHourPerChannel, updatedBy, updatedAt } = await getRepositories().notifications.getSettings();
    return { dedupWindowMinutes, maxPerHourPerChannel, updatedBy, updatedAt };
  },

  async updateSettings(actor: string, patch: Pick<NotificationSettingsPatch, 'dedupWindowMinutes' | 'maxPerHourPerChannel'>) {
    const repos = getRepositories();
    await repos.notifications.updateSettings(patch, actor);
    await repos.audit.record(actor, 'notification.settings_update', 'notifications', { changed: patch });
    return notificationService.getSettings();
  },

  log(q: NotificationLogQuery): Promise<PageResult<NotificationLogEntry>> {
    return getRepositories().notifications.listLog(q);
  },

  /** Sends a labelled test through the real adapter (dry-run / not-configured are recorded honestly). */
  async testSend(actor: string, channel: NotificationChannelName, severity: Severity): Promise<NotificationLogEntry> {
    const entry = await getNotificationRuntime().engine.sendTest(channel, severity);
    await getRepositories().audit.record(
      actor, 'notification.test_send', channel, { channel, severity, status: entry.status },
      entry.status === 'SENT' || entry.status === 'DRY_RUN' ? 'SUCCESS' : 'FAILURE',
    );
    return entry;
  },

  /**
   * Read-only connection check for the e-mail (SNS) channel: proves credentials, region and topic without publishing.
   * Slack and Teams have no read-only probe (a webhook can only be tested by posting), so they use test-send.
   */
  async checkConnection(actor: string, channel: NotificationChannelName): Promise<SnsConnectionCheck> {
    if (channel !== 'EMAIL') {
      throw new ValidationError('A connection check is only available for EMAIL. Use "Send test" for Slack and Teams.');
    }
    const email = getNotificationRuntime().channels.EMAIL;
    const result: SnsConnectionCheck =
      email instanceof SnsEmailChannel
        ? await email.checkConnection()
        : { ok: false, topicName: null, subscriptionsConfirmed: null, subscriptionsPending: null, encrypted: null, message: 'E-mail channel is not backed by SNS' };
    await getRepositories().audit.record(
      actor, 'notification.test_send', channel,
      { channel, check: true, ok: result.ok, confirmed: result.subscriptionsConfirmed, pending: result.subscriptionsPending },
      result.ok ? 'SUCCESS' : 'FAILURE',
    );
    return result;
  },
  /** Retention for the delivery log and the dedup claims. 0 days = keep forever. */
  async purgeExpired(now: Date = new Date(), days = config.notifications.logRetentionDays): Promise<number | null> {
    if (days <= 0) return null;
    return getRepositories().notifications.purgeOlderThan(new Date(now.getTime() - days * 86_400_000).toISOString());
  },
};

/** Daily purge of the delivery log (sibling of the audit retention job). Returns a stop function. */
export function startNotificationRetentionJob(): () => void {
  if (config.notifications.logRetentionDays <= 0) return () => undefined;
  const run = () =>
    notificationService
      .purgeExpired()
      .then((n) => logger.info('Notification log retention purge done', { purged: n }))
      .catch((err) => logger.warn('Notification log retention purge failed', { error: err instanceof Error ? err.message : String(err) }));
  void run();
  const timer = setInterval(run, 24 * 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
