import { randomUUID } from 'node:crypto';
import type { NotificationChannelName, NotificationLogEntry, NotificationRule, NotificationStatus, Severity } from '@urbani/shared';
import { getDb } from '../../db/connection';
import { PersistenceError } from '../../lib/errors';
import { clampPage } from '../common';
import type {
  NewNotificationLog, NewNotificationRule, NotificationLogQuery, NotificationRepository, NotificationRulePatch,
  NotificationSettingsPatch, NotificationSettingsRecord, PageResult,
} from '../types';
import type { SqliteContext } from './index';

interface RuleRow {
  id: string; name: string; enabled: number; min_severity: string; services: string; anomaly_types: string;
  channels: string; created_by: string; updated_by: string; created_at: string; updated_at: string;
}
interface SettingsRow {
  dedup_window_minutes: number; max_per_hour_per_channel: number; engine_enabled_at: string | null;
  default_rule_seeded: number; updated_by: string | null; updated_at: string | null;
}
interface LogRow {
  id: string; timestamp: string; alert_id: string | null; rule_id: string | null; channel: string; status: string;
  attempts: number; error: string | null; provider_message_id: string | null; is_test: number; summary: string | null;
}

const ruleOf = (r: RuleRow): NotificationRule => ({
  id: r.id, name: r.name, enabled: r.enabled === 1, minSeverity: r.min_severity as Severity,
  services: JSON.parse(r.services) as string[], anomalyTypes: JSON.parse(r.anomaly_types) as string[],
  channels: JSON.parse(r.channels) as NotificationChannelName[],
  createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
});
const settingsOf = (s: SettingsRow): NotificationSettingsRecord => ({
  dedupWindowMinutes: s.dedup_window_minutes, maxPerHourPerChannel: s.max_per_hour_per_channel,
  engineEnabledAt: s.engine_enabled_at, defaultRuleSeeded: s.default_rule_seeded === 1,
  updatedBy: s.updated_by, updatedAt: s.updated_at,
});
const logOf = (r: LogRow): NotificationLogEntry => ({
  id: r.id, timestamp: r.timestamp, alertId: r.alert_id, ruleId: r.rule_id, channel: r.channel as NotificationChannelName,
  status: r.status as NotificationStatus, attempts: r.attempts, error: r.error,
  providerMessageId: r.provider_message_id, isTest: r.is_test === 1, summary: r.summary,
});

/** Notifications, SQLite driver. Each method runs synchronously inside its async wrapper, so claims are atomic. */
export function sqliteNotificationRepository(ctx: SqliteContext): NotificationRepository {
  const db = () => getDb();
  const getRuleSync = (id: string): NotificationRule | null => {
    const r = db().prepare('SELECT * FROM notification_rules WHERE id = ?').get(id) as RuleRow | undefined;
    return r ? ruleOf(r) : null;
  };
  const settingsSync = (): NotificationSettingsRecord =>
    settingsOf(db().prepare('SELECT * FROM notification_settings WHERE id = 1').get() as SettingsRow);

  return {
    async listRules() {
      return (db().prepare('SELECT * FROM notification_rules ORDER BY created_at, id').all() as RuleRow[]).map(ruleOf);
    },
    async getRule(id) {
      return getRuleSync(id);
    },
    async createRule(input: NewNotificationRule) {
      const now = ctx.now();
      const id = input.id ?? randomUUID();
      if (getRuleSync(id)) throw new PersistenceError('DUPLICATE', 'Record already exists');
      db()
        .prepare(
          `INSERT INTO notification_rules (id, name, enabled, min_severity, services, anomaly_types, channels,
             created_by, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, input.name, input.enabled ? 1 : 0, input.minSeverity, JSON.stringify(input.services),
          JSON.stringify(input.anomalyTypes), JSON.stringify(input.channels), input.createdBy, input.createdBy, now, now);
      return getRuleSync(id) as NotificationRule;
    },
    async updateRule(id: string, patch: NotificationRulePatch, actor: string) {
      const cur = getRuleSync(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db()
        .prepare(
          `UPDATE notification_rules SET name=?, enabled=?, min_severity=?, services=?, anomaly_types=?, channels=?,
             updated_by=?, updated_at=? WHERE id=?`,
        )
        .run(next.name, next.enabled ? 1 : 0, next.minSeverity, JSON.stringify(next.services),
          JSON.stringify(next.anomalyTypes), JSON.stringify(next.channels), actor, ctx.now(), id);
      return getRuleSync(id);
    },
    async deleteRule(id) {
      return db().prepare('DELETE FROM notification_rules WHERE id = ?').run(id).changes > 0;
    },
    async getSettings() {
      return settingsSync();
    },
    async updateSettings(patch: NotificationSettingsPatch, actor: string) {
      const cur = settingsSync();
      db()
        .prepare(
          `UPDATE notification_settings SET dedup_window_minutes=?, max_per_hour_per_channel=?, default_rule_seeded=?,
             updated_by=?, updated_at=? WHERE id=1`,
        )
        .run(patch.dedupWindowMinutes ?? cur.dedupWindowMinutes, patch.maxPerHourPerChannel ?? cur.maxPerHourPerChannel,
          (patch.defaultRuleSeeded ?? cur.defaultRuleSeeded) ? 1 : 0, actor, ctx.now());
      return settingsSync();
    },
    async setEngineEnabledAtIfUnset(iso) {
      db().prepare('UPDATE notification_settings SET engine_enabled_at = ? WHERE id = 1 AND engine_enabled_at IS NULL').run(iso);
      return settingsSync().engineEnabledAt as string;
    },
    async claim(dedupKey, channel, windowMs) {
      const now = ctx.now();
      if (windowMs === null) {
        return (
          db()
            .prepare('INSERT INTO notification_claims (dedup_key, channel, claimed_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
            .run(dedupKey, channel, now).changes === 1
        );
      }
      const cutoff = new Date(Date.parse(now) - windowMs).toISOString();
      return (
        db()
          .prepare(
            `INSERT INTO notification_claims (dedup_key, channel, claimed_at) VALUES (?,?,?)
             ON CONFLICT (dedup_key, channel) DO UPDATE SET claimed_at = excluded.claimed_at
             WHERE notification_claims.claimed_at <= ?`,
          )
          .run(dedupKey, channel, now, cutoff).changes === 1
      );
    },
    async appendLog(entry: NewNotificationLog) {
      const id = randomUUID();
      const timestamp = ctx.now();
      db()
        .prepare(
          `INSERT INTO notification_log (id, timestamp, alert_id, rule_id, channel, status, attempts, error,
             provider_message_id, is_test, summary) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, timestamp, entry.alertId, entry.ruleId, entry.channel, entry.status, entry.attempts, entry.error,
          entry.providerMessageId, entry.isTest ? 1 : 0, entry.summary);
      return { ...entry, id, timestamp };
    },
    async listLog(q: NotificationLogQuery): Promise<PageResult<NotificationLogEntry>> {
      const params = { channel: q.channel ?? null, status: q.status ?? null, alertId: q.alertId ?? null, from: q.from ?? null, to: q.to ?? null };
      const where = `WHERE (@channel IS NULL OR channel = @channel) AND (@status IS NULL OR status = @status)
        AND (@alertId IS NULL OR alert_id = @alertId) AND (@from IS NULL OR timestamp >= @from) AND (@to IS NULL OR timestamp <= @to)`;
      const total = (db().prepare(`SELECT COUNT(*) AS c FROM notification_log ${where}`).get(params) as { c: number }).c;
      const { pageSize, offset } = clampPage(q.page, q.pageSize, 50);
      const rows = db()
        .prepare(`SELECT * FROM notification_log ${where} ORDER BY timestamp DESC, id DESC LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit: pageSize, offset }) as LogRow[];
      return { items: rows.map(logOf), total };
    },
    async countDeliveries(channel, sinceIso) {
      return (
        db()
          .prepare(
            `SELECT COUNT(*) AS c FROM notification_log WHERE channel = ? AND timestamp >= ? AND is_test = 0
               AND status IN ('SENT','FAILED','DRY_RUN')`,
          )
          .get(channel, sinceIso) as { c: number }
      ).c;
    },
    async purgeOlderThan(cutoff) {
      db().prepare('DELETE FROM notification_claims WHERE claimed_at < ?').run(cutoff);
      return db().prepare('DELETE FROM notification_log WHERE timestamp < ?').run(cutoff).changes;
    },
  };
}
