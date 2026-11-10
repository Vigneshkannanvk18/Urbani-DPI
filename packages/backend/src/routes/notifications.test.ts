import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { UserRole } from '@urbani/shared';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { authService } from '../services/authService';
import { buildRuntime, setNotificationRuntimeForTesting } from '../notifications/runtime';
import type { FetchLike } from '../notifications/channels';
import { resetTestSendLimiter } from './notificationRoutes';

/** Notification API (DPI 2 item 6): RBAC matrix, validation, audit, test-send, rate limit, no URLs in responses. */
const PASSWORD = 'Str0ng-Passw0rd!';
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/TOPSECRETTOKEN';
const TEAMS_URL = 'https://contoso.webhook.office.com/webhookb2/TOPSECRETTEAMS';
const app = createApp();
let db: ReturnType<typeof freshTestDb>;
const tokens = {} as Record<string, string>;
const fetchMock = vi.fn(async () => ({ status: 200, text: async () => 'ok' }));

const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, token?: string, body?: object) => {
  const r = request(app)[method](path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const auditActions = async (action: string) =>
  (await getRepositories().audit.listByTimeRange({ actions: [action], limit: 50 })).items;

function useRuntime(over: Partial<typeof config.notifications> = {}) {
  setNotificationRuntimeForTesting(
    buildRuntime(
      { ...config.notifications, slackWebhookUrl: SLACK_URL, teamsWebhookUrl: TEAMS_URL, dryRun: false, ...over },
      { fetchImpl: fetchMock as unknown as FetchLike, sns: { send: vi.fn(async () => ({ MessageId: 'sns-1' })) } },
    ),
  );
}

beforeAll(async () => {
  db = freshTestDb();
  await seed();
  const admin = await authService.login(config.auth.seedAdminEmail, config.auth.seedAdminPassword);
  tokens.SUPER_ADMIN = admin.token;
  for (const role of ['INFRA_ADMIN', 'QA_OPERATOR', 'READER_AUDITOR'] as UserRole[]) {
    await call('post', '/api/users', tokens.SUPER_ADMIN, { email: `${role.toLowerCase()}@urbani.test`, displayName: role, role, password: PASSWORD });
    tokens[role] = (await authService.login(`${role.toLowerCase()}@urbani.test`, PASSWORD)).token;
  }
});
afterAll(() => {
  setNotificationRuntimeForTesting(null);
  db.close();
});
beforeEach(() => {
  fetchMock.mockClear();
  resetTestSendLimiter();
  useRuntime();
});

const RULE = { name: 'Payments high', minSeverity: 'HIGH', services: ['payments'], channels: ['SLACK', 'TEAMS'] };

describe('RBAC matrix', () => {
  it('requires authentication', async () => {
    expect((await call('get', '/api/notifications/rules')).status).toBe(401);
  });

  it('everyone with alerts:view can read channels, rules, settings and log', async () => {
    for (const role of ['SUPER_ADMIN', 'INFRA_ADMIN', 'QA_OPERATOR', 'READER_AUDITOR']) {
      for (const p of ['channels', 'rules', 'settings', 'log']) {
        expect((await call('get', `/api/notifications/${p}`, tokens[role])).status, `${role} ${p}`).toBe(200);
      }
    }
  });

  it('QA operator and reader cannot mutate or test-send (403, audited as denied)', async () => {
    for (const role of ['QA_OPERATOR', 'READER_AUDITOR']) {
      expect((await call('post', '/api/notifications/rules', tokens[role], RULE)).status, role).toBe(403);
      expect((await call('put', '/api/notifications/rules/x', tokens[role], { enabled: false })).status).toBe(403);
      expect((await call('delete', '/api/notifications/rules/x', tokens[role])).status).toBe(403);
      expect((await call('put', '/api/notifications/settings', tokens[role], { dedupWindowMinutes: 5 })).status).toBe(403);
      expect((await call('post', '/api/notifications/test', tokens[role], { channel: 'SLACK' })).status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getRepositories().audit.listByTimeRange({ actions: ['access.denied'], limit: 50 })).items.length).toBeGreaterThan(0);
  });

  it('Super Admin and Infra Admin can mutate', async () => {
    for (const role of ['SUPER_ADMIN', 'INFRA_ADMIN']) {
      const res = await call('post', '/api/notifications/rules', tokens[role], { ...RULE, name: `by ${role}` });
      expect(res.status, role).toBe(201);
    }
  });
});

describe('rules CRUD, settings and audit', () => {
  it('lists the DRAFT default rule on first read', async () => {
    const res = await call('get', '/api/notifications/rules', tokens.READER_AUDITOR);
    const def = res.body.data.find((r: { id: string }) => r.id === 'rule-default-critical-high');
    expect(def).toMatchObject({ enabled: true, minSeverity: 'HIGH', channels: ['EMAIL', 'SLACK', 'TEAMS'], services: [] });
    expect(def.name).toContain('DRAFT');
  });

  it('creates, updates and deletes a rule, each audited once', async () => {
    const created = await call('post', '/api/notifications/rules', tokens.SUPER_ADMIN, RULE);
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({ ...RULE, enabled: true, anomalyTypes: [], createdBy: config.auth.seedAdminEmail });

    const upd = await call('put', `/api/notifications/rules/${id}`, tokens.SUPER_ADMIN, { enabled: false, minSeverity: 'CRITICAL' });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ enabled: false, minSeverity: 'CRITICAL', name: RULE.name });

    expect((await call('delete', `/api/notifications/rules/${id}`, tokens.SUPER_ADMIN)).status).toBe(200);
    expect((await call('delete', `/api/notifications/rules/${id}`, tokens.SUPER_ADMIN)).status).toBe(404);
    expect((await call('put', `/api/notifications/rules/${id}`, tokens.SUPER_ADMIN, { enabled: true })).status).toBe(404);

    for (const a of ['notification.rule_create', 'notification.rule_update', 'notification.rule_delete']) {
      expect((await auditActions(a)).some((e) => e.target === id), a).toBe(true);
    }
  });

  it('validates input with 400', async () => {
    const bad = [
      { ...RULE, name: '' },
      { ...RULE, minSeverity: 'URGENT' },
      { ...RULE, channels: [] },
      { ...RULE, channels: ['SMS'] },
      { ...RULE, services: [1] },
      { name: 'x' },
    ];
    for (const body of bad) expect((await call('post', '/api/notifications/rules', tokens.SUPER_ADMIN, body)).status, JSON.stringify(body)).toBe(400);
    expect((await call('put', '/api/notifications/rules/x', tokens.SUPER_ADMIN, {})).status).toBe(400);
    expect((await call('put', '/api/notifications/settings', tokens.SUPER_ADMIN, {})).status).toBe(400);
    expect((await call('put', '/api/notifications/settings', tokens.SUPER_ADMIN, { dedupWindowMinutes: -1 })).status).toBe(400);
    expect((await call('put', '/api/notifications/settings', tokens.SUPER_ADMIN, { maxPerHourPerChannel: 0 })).status).toBe(400);
    expect((await call('get', '/api/notifications/log?channel=SMS', tokens.SUPER_ADMIN)).status).toBe(400);
    expect((await call('get', '/api/notifications/log?from=yesterday', tokens.SUPER_ADMIN)).status).toBe(400);
    expect((await call('post', '/api/notifications/test', tokens.SUPER_ADMIN, { channel: 'FAX' })).status).toBe(400);
    expect((await call('post', '/api/notifications/test', tokens.SUPER_ADMIN, { channel: 'SLACK', severity: 'BAD' })).status).toBe(400);
  });

  it('settings default to 30 / 30, can be updated and the change is audited', async () => {
    expect((await call('get', '/api/notifications/settings', tokens.READER_AUDITOR)).body.data).toMatchObject({ dedupWindowMinutes: 30, maxPerHourPerChannel: 30 });
    const res = await call('put', '/api/notifications/settings', tokens.INFRA_ADMIN, { dedupWindowMinutes: 10, maxPerHourPerChannel: 12 });
    expect(res.body.data).toMatchObject({ dedupWindowMinutes: 10, maxPerHourPerChannel: 12, updatedBy: 'infra_admin@urbani.test' });
    expect((await auditActions('notification.settings_update')).length).toBeGreaterThan(0);
  });
});

describe('channels', () => {
  it('reports status per channel with a masked destination and no URL', async () => {
    const res = await call('get', '/api/notifications/channels', tokens.READER_AUDITOR);
    const byName = Object.fromEntries(res.body.data.map((c: { channel: string }) => [c.channel, c]));
    expect(byName.SLACK).toMatchObject({ status: 'CONFIGURED', destination: 'hooks.slack.com' });
    expect(byName.TEAMS).toMatchObject({ status: 'CONFIGURED', destination: '***.webhook.office.com' });
    expect(byName.EMAIL).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'ALERT_SNS_TOPIC_ARN is not set' });
    expect(JSON.stringify(res.body)).not.toContain('TOPSECRET');
  });

  it('shows DRY_RUN for every channel when NOTIFICATIONS_DRY_RUN is on', async () => {
    useRuntime({ dryRun: true });
    const res = await call('get', '/api/notifications/channels', tokens.SUPER_ADMIN);
    expect(res.body.data.map((c: { status: string }) => c.status)).toEqual(['DRY_RUN', 'DRY_RUN', 'DRY_RUN']);
  });

  it('a webhook on a disallowed host is NOT_CONFIGURED with a clear reason, not a crash', async () => {
    useRuntime({ slackWebhookUrl: 'https://evil.example.com/hook/TOPSECRETTOKEN' });
    const res = await call('get', '/api/notifications/channels', tokens.SUPER_ADMIN);
    const slack = res.body.data.find((c: { channel: string }) => c.channel === 'SLACK');
    expect(slack).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'SLACK_WEBHOOK_URL rejected: host is not on the allow-list' });
    expect(JSON.stringify(res.body)).not.toContain('evil.example.com');
  });
});

describe('test-send', () => {
  it('sends a labelled message through the real adapter, logs it and audits it, with no URL in any response', async () => {
    const res = await call('post', '/api/notifications/test', tokens.INFRA_ADMIN, { channel: 'SLACK', severity: 'CRITICAL' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ channel: 'SLACK', status: 'SENT', isTest: true, alertId: null, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.text).toContain('[TEST] Urbani Radar notification test');
    expect(body.text).toContain('SIMULATED');

    const audit = (await auditActions('notification.test_send'))[0];
    expect(audit).toMatchObject({ actor: 'infra_admin@urbani.test', target: 'SLACK', result: 'SUCCESS' });

    const log = await call('get', '/api/notifications/log?channel=SLACK&status=SENT', tokens.READER_AUDITOR);
    expect(log.body.data.items[0]).toMatchObject({ isTest: true, channel: 'SLACK' });
    // never an alert
    expect((await getRepositories().alerts.query({ search: 'SIMULATED' })).total).toBe(0);
    const everything = JSON.stringify([res.body, log.body, await auditActions('notification.test_send')]);
    expect(everything).not.toContain('TOPSECRET');
    expect(everything).not.toContain('hooks.slack.com/services');
  });

  it('sends e-mail through SNS and returns the MessageId', async () => {
    useRuntime({ snsTopicArn: 'arn:aws:sns:us-east-1:123456789012:urbani-alerts' });
    const res = await call('post', '/api/notifications/test', tokens.SUPER_ADMIN, { channel: 'EMAIL' });
    expect(res.body.data).toMatchObject({ channel: 'EMAIL', status: 'SENT', providerMessageId: 'sns-1' });
  });

  it('is dry-run under NOTIFICATIONS_DRY_RUN and sends nothing', async () => {
    useRuntime({ dryRun: true });
    const res = await call('post', '/api/notifications/test', tokens.SUPER_ADMIN, { channel: 'TEAMS' });
    expect(res.body.data.status).toBe('DRY_RUN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when the channel is not configured', async () => {
    const res = await call('post', '/api/notifications/test', tokens.SUPER_ADMIN, { channel: 'EMAIL' });
    expect(res.body.data).toMatchObject({ status: 'SKIPPED_NOT_CONFIGURED', error: 'not delivered: channel not configured' });
    expect((await auditActions('notification.test_send'))[0].result).toBe('FAILURE');
  });

  it('records FAILED with a redacted error when the provider rejects', async () => {
    fetchMock.mockResolvedValueOnce({ status: 404, text: async () => 'no_service' });
    const res = await call('post', '/api/notifications/test', tokens.SUPER_ADMIN, { channel: 'SLACK' });
    expect(res.body.data).toMatchObject({ status: 'FAILED', attempts: 1, error: 'HTTP 404' });
  });

  it('is rate limited to 5 per minute per user', async () => {
    useRuntime({ dryRun: true });
    for (let i = 0; i < 5; i++) expect((await call('post', '/api/notifications/test', tokens.SUPER_ADMIN, { channel: 'SLACK' })).status).toBe(200);
    const res = await call('post', '/api/notifications/test', tokens.SUPER_ADMIN, { channel: 'SLACK' });
    expect(res.status).toBe(429);
    // another user is unaffected
    expect((await call('post', '/api/notifications/test', tokens.INFRA_ADMIN, { channel: 'SLACK' })).status).toBe(200);
  });
});

describe('SNS connection check (read-only)', () => {
  const ARN = 'arn:aws:sns:us-east-1:123456789012:urbani-alerts';
  const useSns = (send: ReturnType<typeof vi.fn>) =>
    setNotificationRuntimeForTesting(
      buildRuntime({ ...config.notifications, snsTopicArn: ARN, dryRun: false }, { fetchImpl: fetchMock as unknown as FetchLike, sns: { send } as never }),
    );
  it('needs alerts:rules (QA Operator and Reader/Auditor are refused)', async () => {
    for (const role of ['QA_OPERATOR', 'READER_AUDITOR']) {
      expect((await call('post', '/api/notifications/check', tokens[role], { channel: 'EMAIL' })).status, role).toBe(403);
    }
  });
  it('returns subscriber counts, never the ARN, publishes nothing, and audits the check', async () => {
    const send = vi.fn(async () => ({ Attributes: { SubscriptionsConfirmed: '1', SubscriptionsPending: '2' } }));
    useSns(send);
    const res = await call('post', '/api/notifications/check', tokens.INFRA_ADMIN, { channel: 'EMAIL' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, topicName: 'urbani-alerts', subscriptionsConfirmed: 1, subscriptionsPending: 2 });
    expect(JSON.stringify(res.body)).not.toContain(ARN);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].constructor.name).toBe('GetTopicAttributesCommand');
    const audit = (await auditActions('notification.test_send'))[0];
    expect(audit).toMatchObject({ actor: 'infra_admin@urbani.test', target: 'EMAIL', result: 'SUCCESS' });
  });
  it('reports a failed check as ok:false with a hint and records FAILURE', async () => {
    useSns(vi.fn(async () => { throw Object.assign(new Error('nope'), { name: 'AuthorizationErrorException' }); }));
    const res = await call('post', '/api/notifications/check', tokens.SUPER_ADMIN, { channel: 'EMAIL' });
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.message).toContain('sns:GetTopicAttributes');
    expect((await auditActions('notification.test_send'))[0].result).toBe('FAILURE');
  });
  it('rejects channels without a read-only probe and unknown channels', async () => {
    expect((await call('post', '/api/notifications/check', tokens.SUPER_ADMIN, { channel: 'SLACK' })).status).toBe(400);
    expect((await call('post', '/api/notifications/check', tokens.SUPER_ADMIN, { channel: 'FAX' })).status).toBe(400);
  });
  it('says it is not configured without calling AWS', async () => {
    const res = await call('post', '/api/notifications/check', tokens.SUPER_ADMIN, { channel: 'EMAIL' });
    expect(res.body.data).toMatchObject({ ok: false, message: 'ALERT_SNS_TOPIC_ARN is not set' });
  });
});
describe('log API', () => {
  it('filters by channel, status, alertId and time and paginates', async () => {
    const n = getRepositories().notifications;
    for (let i = 0; i < 5; i++) {
      await n.appendLog({ alertId: `A${i}`, ruleId: 'r', channel: i % 2 ? 'TEAMS' : 'SLACK', status: i === 4 ? 'FAILED' : 'SENT', attempts: 1, error: null, providerMessageId: null, isTest: false, summary: 's' });
    }
    const failed = await call('get', '/api/notifications/log?status=FAILED&alertId=A4', tokens.READER_AUDITOR);
    expect(failed.body.data.items).toHaveLength(1);
    const page = await call('get', '/api/notifications/log?channel=SLACK&pageSize=2&page=1', tokens.READER_AUDITOR);
    expect(page.body.data.total).toBeGreaterThanOrEqual(3);
    expect(page.body.data.items).toHaveLength(2);
    const future = await call('get', `/api/notifications/log?from=${encodeURIComponent('2999-01-01T00:00:00.000Z')}`, tokens.READER_AUDITOR);
    expect(future.body.data.total).toBe(0);
  });
});
