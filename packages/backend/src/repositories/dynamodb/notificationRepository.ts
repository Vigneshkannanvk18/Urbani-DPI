import { createHash, randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { NotificationChannelName, NotificationLogEntry, NotificationRule, NotificationStatus, Severity } from '@urbani/shared';
import { PersistenceError } from '../../lib/errors';
import { clampPage } from '../common';
import type {
  NewNotificationLog, NewNotificationRule, NotificationLogQuery, NotificationRepository, NotificationRulePatch,
  NotificationSettingsPatch, NotificationSettingsRecord, PageResult,
} from '../types';
import type { DynamoRepositoryContext } from './index';
import { fitsSortKey } from './keys';
import {
  CONDITIONAL_CHECK_FAILED, batchWriteAll, isConditionalCheckFailed, partitionQuery, queryAll, queryPage, send,
} from './ops';

/**
 * Notifications, DynamoDB driver. Same single table; partitions NOTIFRULE (SK = rule id), NOTIFSETTINGS (one item),
 * NOTIFCLAIM (SK = `<channel>#<dedupKey>`) and NOTIFLOG (SK = `<timestamp>#<id>`, time ordered like the audit log).
 * The claim is a conditional Put, so exactly one concurrent caller wins.
 */
const RULE_PK = 'NOTIFRULE';
const SETTINGS_KEY = { PK: 'NOTIFSETTINGS', SK: 'GLOBAL' };
const CLAIM_PK = 'NOTIFCLAIM';
const LOG_PK = 'NOTIFLOG';

type Item = Record<string, unknown>;

const ruleOf = (i: Item): NotificationRule => ({
  id: i.id as string, name: i.name as string, enabled: i.enabled === true, minSeverity: i.minSeverity as Severity,
  services: (i.services as string[]) ?? [], anomalyTypes: (i.anomalyTypes as string[]) ?? [],
  channels: (i.channels as NotificationChannelName[]) ?? [],
  createdBy: i.createdBy as string, updatedBy: i.updatedBy as string,
  createdAt: i.createdAt as string, updatedAt: i.updatedAt as string,
});
const logOf = (i: Item): NotificationLogEntry => ({
  id: i.id as string, timestamp: i.timestamp as string, alertId: (i.alertId as string) ?? null,
  ruleId: (i.ruleId as string) ?? null, channel: i.channel as NotificationChannelName,
  status: i.status as NotificationStatus, attempts: (i.attempts as number) ?? 0, error: (i.error as string) ?? null,
  providerMessageId: (i.providerMessageId as string) ?? null, isTest: i.isTest === true, summary: (i.summary as string) ?? null,
});
const settingsOf = (i: Item | undefined): NotificationSettingsRecord => ({
  dedupWindowMinutes: (i?.dedupWindowMinutes as number) ?? 30,
  maxPerHourPerChannel: (i?.maxPerHourPerChannel as number) ?? 30,
  engineEnabledAt: (i?.engineEnabledAt as string) ?? null,
  defaultRuleSeeded: i?.defaultRuleSeeded === true,
  updatedBy: (i?.updatedBy as string) ?? null,
  updatedAt: (i?.updatedAt as string) ?? null,
});

function claimSortKey(channel: string, dedupKey: string): string {
  const sk = `${channel}#${dedupKey}`;
  return fitsSortKey(sk) && Buffer.byteLength(sk) <= 900 ? sk : `${channel}#h:${createHash('sha256').update(dedupKey).digest('hex')}`;
}

export function dynamoNotificationRepository(ctx: DynamoRepositoryContext): NotificationRepository {
  async function getRule(id: string): Promise<NotificationRule | null> {
    if (!id || Buffer.byteLength(id) > 512) return null;
    const res = await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: { PK: RULE_PK, SK: id }, ConsistentRead: true }),
      'notifications.getRule',
    );
    return res.Item ? ruleOf(res.Item) : null;
  }
  async function getSettings(): Promise<NotificationSettingsRecord> {
    const res = await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: SETTINGS_KEY, ConsistentRead: true }),
      'notifications.getSettings',
    );
    return settingsOf(res.Item);
  }
  async function setAttrs(attrs: Record<string, unknown>, op: string): Promise<void> {
    const names: Record<string, string> = { '#et': 'entityType' };
    const values: Record<string, unknown> = { ':et': 'NOTIFICATION_SETTINGS' };
    const sets = ['#et = :et'];
    Object.entries(attrs).forEach(([k, v], n) => {
      names[`#a${n}`] = k;
      values[`:a${n}`] = v;
      sets.push(`#a${n} = :a${n}`);
    });
    await send(
      ctx,
      new UpdateCommand({
        TableName: ctx.tableName, Key: SETTINGS_KEY, UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }),
      op,
    );
  }
  /** Items of the log partition within [from, to], newest first, optional extra filter. */
  function logQuery(from: string | null, to: string | null, filter?: { expr: string; names: Record<string, string>; values: Record<string, unknown> }) {
    const names: Record<string, string> = { '#pk': 'PK', ...(filter?.names ?? {}) };
    const values: Record<string, unknown> = { ':pk': LOG_PK, ...(filter?.values ?? {}) };
    let cond = '#pk = :pk';
    if (from !== null || to !== null) {
      names['#sk'] = 'SK';
      if (from !== null) values[':from'] = from;
      if (to !== null) values[':toHi'] = `${to}$`;
      cond += from !== null && to !== null ? ' AND #sk BETWEEN :from AND :toHi' : from !== null ? ' AND #sk >= :from' : ' AND #sk <= :toHi';
    }
    return {
      KeyConditionExpression: cond, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      ...(filter ? { FilterExpression: filter.expr } : {}), ScanIndexForward: false, ConsistentRead: true,
    };
  }

  return {
    async listRules() {
      const items = await queryAll<Item>(ctx, partitionQuery(RULE_PK), 'notifications.listRules');
      return items.map(ruleOf).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    getRule,
    async createRule(input: NewNotificationRule) {
      const now = ctx.now();
      const id = input.id ?? randomUUID();
      const item = {
        PK: RULE_PK, SK: id, entityType: 'NOTIFICATION_RULE', id, name: input.name, enabled: input.enabled,
        minSeverity: input.minSeverity, services: input.services, anomalyTypes: input.anomalyTypes, channels: input.channels,
        createdBy: input.createdBy, updatedBy: input.createdBy, createdAt: now, updatedAt: now,
      };
      try {
        await send(
          ctx,
          new PutCommand({
            TableName: ctx.tableName, Item: item, ConditionExpression: 'attribute_not_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'PK' },
          }),
          'notifications.createRule',
          { handled: [CONDITIONAL_CHECK_FAILED] },
        );
      } catch (err) {
        if (isConditionalCheckFailed(err)) throw new PersistenceError('DUPLICATE', 'Record already exists');
        throw err;
      }
      return ruleOf(item);
    },
    async updateRule(id: string, patch: NotificationRulePatch, actor: string) {
      const cur = await getRule(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      try {
        await send(
          ctx,
          new PutCommand({
            TableName: ctx.tableName,
            Item: {
              PK: RULE_PK, SK: id, entityType: 'NOTIFICATION_RULE', id, name: next.name, enabled: next.enabled,
              minSeverity: next.minSeverity, services: next.services, anomalyTypes: next.anomalyTypes, channels: next.channels,
              createdBy: cur.createdBy, updatedBy: actor, createdAt: cur.createdAt, updatedAt: ctx.now(),
            },
            ConditionExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'PK' },
          }),
          'notifications.updateRule',
          { handled: [CONDITIONAL_CHECK_FAILED] },
        );
      } catch (err) {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      }
      return getRule(id);
    },
    async deleteRule(id) {
      if (!id || Buffer.byteLength(id) > 512) return false;
      try {
        await send(
          ctx,
          new DeleteCommand({
            TableName: ctx.tableName, Key: { PK: RULE_PK, SK: id }, ConditionExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'PK' },
          }),
          'notifications.deleteRule',
          { handled: [CONDITIONAL_CHECK_FAILED] },
        );
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },
    getSettings,
    async updateSettings(patch: NotificationSettingsPatch, actor: string) {
      const attrs: Record<string, unknown> = { updatedBy: actor, updatedAt: ctx.now() };
      if (patch.dedupWindowMinutes !== undefined) attrs.dedupWindowMinutes = patch.dedupWindowMinutes;
      if (patch.maxPerHourPerChannel !== undefined) attrs.maxPerHourPerChannel = patch.maxPerHourPerChannel;
      if (patch.defaultRuleSeeded !== undefined) attrs.defaultRuleSeeded = patch.defaultRuleSeeded;
      await setAttrs(attrs, 'notifications.updateSettings');
      return getSettings();
    },
    async setEngineEnabledAtIfUnset(iso) {
      try {
        await send(
          ctx,
          new UpdateCommand({
            TableName: ctx.tableName, Key: SETTINGS_KEY,
            UpdateExpression: 'SET #w = :w, #et = :et',
            ConditionExpression: 'attribute_not_exists(#w)',
            ExpressionAttributeNames: { '#w': 'engineEnabledAt', '#et': 'entityType' },
            ExpressionAttributeValues: { ':w': iso, ':et': 'NOTIFICATION_SETTINGS' },
          }),
          'notifications.setWatermark',
          { handled: [CONDITIONAL_CHECK_FAILED] },
        );
        return iso;
      } catch (err) {
        if (!isConditionalCheckFailed(err)) throw err;
        return (await getSettings()).engineEnabledAt as string;
      }
    },
    async claim(dedupKey, channel, windowMs) {
      const now = ctx.now();
      const cutoff = windowMs === null ? null : new Date(Date.parse(now) - windowMs).toISOString();
      try {
        await send(
          ctx,
          new PutCommand({
            TableName: ctx.tableName,
            Item: { PK: CLAIM_PK, SK: claimSortKey(channel, dedupKey), entityType: 'NOTIFICATION_CLAIM', claimedAt: now },
            ConditionExpression: cutoff === null ? 'attribute_not_exists(#pk)' : 'attribute_not_exists(#pk) OR #c <= :cutoff',
            ExpressionAttributeNames: cutoff === null ? { '#pk': 'PK' } : { '#pk': 'PK', '#c': 'claimedAt' },
            ...(cutoff === null ? {} : { ExpressionAttributeValues: { ':cutoff': cutoff } }),
          }),
          'notifications.claim',
          { handled: [CONDITIONAL_CHECK_FAILED] },
        );
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },
    async appendLog(entry: NewNotificationLog) {
      const id = randomUUID();
      const timestamp = ctx.now();
      await send(
        ctx,
        new PutCommand({
          TableName: ctx.tableName,
          Item: { PK: LOG_PK, SK: `${timestamp}#${id}`, entityType: 'NOTIFICATION_LOG', id, timestamp, ...entry },
        }),
        'notifications.appendLog',
      );
      return { ...entry, id, timestamp };
    },
    async listLog(q: NotificationLogQuery): Promise<PageResult<NotificationLogEntry>> {
      const parts: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const add = (attr: string, v: string | undefined, key: string) => {
        if (v === undefined) return;
        parts.push(`#${key} = :${key}`);
        names[`#${key}`] = attr;
        values[`:${key}`] = v;
      };
      add('channel', q.channel, 'ch');
      add('status', q.status, 'st');
      add('alertId', q.alertId, 'al');
      const items = await queryAll<Item>(
        ctx,
        logQuery(q.from ?? null, q.to ?? null, parts.length ? { expr: parts.join(' AND '), names, values } : undefined),
        'notifications.listLog',
      );
      const { offset, pageSize } = clampPage(q.page, q.pageSize, 50);
      return { items: items.slice(offset, offset + pageSize).map(logOf), total: items.length };
    },
    async countDeliveries(channel, sinceIso) {
      const items = await queryAll<Item>(
        ctx,
        logQuery(sinceIso, null, {
          expr: '#ch = :ch AND #t = :f AND #st IN (:s1, :s2, :s3)',
          names: { '#ch': 'channel', '#t': 'isTest', '#st': 'status' },
          values: { ':ch': channel, ':f': false, ':s1': 'SENT', ':s2': 'FAILED', ':s3': 'DRY_RUN' },
        }),
        'notifications.countDeliveries',
      );
      return items.length;
    },
    async purgeOlderThan(cutoff) {
      let deleted = 0;
      for (;;) {
        const { items: keys } = await queryPage<{ PK: string; SK: string }>(
          ctx,
          {
            KeyConditionExpression: '#pk = :pk AND #sk < :cutoff',
            ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
            ExpressionAttributeValues: { ':pk': LOG_PK, ':cutoff': cutoff },
            ProjectionExpression: '#pk, #sk', ConsistentRead: true,
          },
          200,
          'notifications.purge',
        );
        if (keys.length === 0) break;
        await batchWriteAll(ctx, keys.map((k) => ({ delete: { PK: k.PK, SK: k.SK } })), 'notifications.purge');
        deleted += keys.length;
      }
      const claims = await queryAll<{ PK: string; SK: string }>(
        ctx,
        partitionQuery(CLAIM_PK, {
          filter: '#c < :cutoff', projection: '#pk, #sk',
          names: { '#c': 'claimedAt', '#sk': 'SK' }, values: { ':cutoff': cutoff },
        }),
        'notifications.purgeClaims',
      );
      if (claims.length) await batchWriteAll(ctx, claims.map((k) => ({ delete: { PK: k.PK, SK: k.SK } })), 'notifications.purgeClaims');
      return deleted;
    },
  };
}
