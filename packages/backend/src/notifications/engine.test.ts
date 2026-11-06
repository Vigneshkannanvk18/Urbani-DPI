import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationChannelName, NotificationRule, Severity, UrbaniIncidentAlert } from '@urbani/shared';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { DeliveryError, type NotificationChannel, type SendResult } from './channels';
import { NotificationEngine, ensureDefaultRule, ruleMatches, type EngineOptions } from './engine';
import type { NotificationMessage } from './message';

class FakeChannel implements NotificationChannel {
  sent: NotificationMessage[] = [];
  constructor(readonly name: NotificationChannelName, private configured = true, private failWith: string | null = null) {}
  isConfigured() { return this.configured; }
  state() { return { status: this.configured ? ('CONFIGURED' as const) : ('NOT_CONFIGURED' as const), destination: null, reason: null }; }
  async send(m: NotificationMessage): Promise<SendResult> {
    if (this.failWith) throw new DeliveryError(this.failWith, 3);
    this.sent.push(m);
    return { providerMessageId: `${this.name}-${this.sent.length}`, attempts: 1 };
  }
}
const channelsOf = (over: Partial<Record<NotificationChannelName, FakeChannel>> = {}) => ({
  EMAIL: over.EMAIL ?? new FakeChannel('EMAIL', false),
  SLACK: over.SLACK ?? new FakeChannel('SLACK'),
  TEAMS: over.TEAMS ?? new FakeChannel('TEAMS', false),
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
let seq = 0;
function alert(over: Partial<UrbaniIncidentAlert> = {}): UrbaniIncidentAlert {
  seq++;
  return {
    alertId: `ALT-${seq}`, timestamp: minutesAgo(2), service: 'main', environment: 'qa', severity: 'CRITICAL',
    anomalyType: `Anomaly${seq}`, summary: 'Something broke', evidence: [], probableCause: 'Unknown',
    recommendedActions: [], confidence: 0.9, modelId: 'm', ...over,
  };
}
const engineOf = (channels: Record<NotificationChannelName, NotificationChannel>, over: Partial<EngineOptions> = {}) =>
  new NotificationEngine(() => getRepositories(), channels, {
    dryRun: false, allowMock: false, maxAlertAgeMinutes: 60, baseUrl: 'https://dash.example.com', ...over,
  });
const logOf = async () => (await getRepositories().notifications.listLog({ pageSize: 200 })).items;

let db: ReturnType<typeof freshTestDb>;
beforeEach(() => { db = freshTestDb(); });
afterEach(() => db.close());

describe('rule matching', () => {
  const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
    id: 'r', name: 'r', enabled: true, minSeverity: 'HIGH', services: [], anomalyTypes: [], channels: ['SLACK'],
    createdBy: 'a', updatedBy: 'a', createdAt: '', updatedAt: '', ...over,
  });
  const a = (severity: Severity, service = 'main', anomalyType = 'X') => ({ severity, service, anomalyType });

  it('applies the severity threshold', () => {
    expect(ruleMatches(rule(), a('CRITICAL'))).toBe(true);
    expect(ruleMatches(rule(), a('HIGH'))).toBe(true);
    expect(ruleMatches(rule(), a('MEDIUM'))).toBe(false);
    expect(ruleMatches(rule({ minSeverity: 'LOW' }), a('LOW'))).toBe(true);
  });
  it('filters by services and anomaly types (empty = all)', () => {
    expect(ruleMatches(rule({ services: ['payments'] }), a('HIGH', 'main'))).toBe(false);
    expect(ruleMatches(rule({ services: ['payments', 'main'] }), a('HIGH', 'main'))).toBe(true);
    expect(ruleMatches(rule({ anomalyTypes: ['Y'] }), a('HIGH'))).toBe(false);
    expect(ruleMatches(rule({ anomalyTypes: ['Y', 'X'] }), a('HIGH'))).toBe(true);
  });
  it('never matches a disabled rule', () => {
    expect(ruleMatches(rule({ enabled: false }), a('CRITICAL'))).toBe(false);
  });
});

describe('default rule', () => {
  it('is seeded once, enabled, HIGH+ to every channel, and not re-created after deletion', async () => {
    const repos = getRepositories();
    await ensureDefaultRule(repos);
    await ensureDefaultRule(repos);
    const rules = await repos.notifications.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ enabled: true, minSeverity: 'HIGH', channels: ['EMAIL', 'SLACK', 'TEAMS'] });
    await repos.notifications.deleteRule(rules[0].id);
    await ensureDefaultRule(repos);
    expect(await repos.notifications.listRules()).toHaveLength(0);
  });
});

describe('engine', () => {
  it('notifies a new OPEN LIVE alert on configured channels and records honest status for the others', async () => {
    const repos = getRepositories();
    await repos.alerts.insert(alert({ alertId: 'A1' }), 'LIVE');
    const ch = channelsOf();
    await engineOf(ch).run();
    expect(ch.SLACK.sent).toHaveLength(1);
    expect(ch.SLACK.sent[0].link).toBe('https://dash.example.com/alerts/A1');
    expect(ch.SLACK.sent[0].confidence).toBe('90% (derived)');
    const byChannel = Object.fromEntries((await logOf()).map((e) => [e.channel, e]));
    expect(byChannel.SLACK).toMatchObject({ status: 'SENT', alertId: 'A1', attempts: 1, providerMessageId: 'SLACK-1', isTest: false });
    expect(byChannel.EMAIL).toMatchObject({ status: 'SKIPPED_NOT_CONFIGURED' });
    expect(byChannel.TEAMS).toMatchObject({ status: 'SKIPPED_NOT_CONFIGURED' });
  });

  it('does not notify again on the next run (silent, no log spam)', async () => {
    await getRepositories().alerts.insert(alert(), 'LIVE');
    const ch = channelsOf();
    const engine = engineOf(ch);
    await engine.run();
    const before = (await logOf()).length;
    await engine.run();
    await engine.run();
    expect(ch.SLACK.sent).toHaveLength(1);
    expect((await logOf()).length).toBe(before);
  });

  it('skips acknowledged alerts, below-threshold alerts and MOCK alerts', async () => {
    const repos = getRepositories();
    await repos.alerts.insert(alert({ alertId: 'ACK' }), 'LIVE');
    await repos.alerts.acknowledge('ACK', 'me');
    await repos.alerts.insert(alert({ alertId: 'LOW', severity: 'MEDIUM' }), 'LIVE');
    await repos.alerts.insert(alert({ alertId: 'MOCK' }), 'MOCK');
    const ch = channelsOf();
    await engineOf(ch).run();
    expect(ch.SLACK.sent).toHaveLength(0);
    expect(await logOf()).toHaveLength(0);
  });

  it('notifies MOCK alerts only with allowMock (demo)', async () => {
    await getRepositories().alerts.insert(alert({ alertId: 'MOCK' }), 'MOCK');
    const ch = channelsOf();
    await engineOf(ch, { allowMock: true }).run();
    expect(ch.SLACK.sent).toHaveLength(1);
    expect(ch.SLACK.sent[0].confidence).toBe('90%'); // not labelled derived for MOCK
  });

  it('first run does not blast historic alerts; later alerts are notified', async () => {
    const repos = getRepositories();
    await repos.alerts.insert(alert({ alertId: 'OLD', timestamp: minutesAgo(300) }), 'LIVE');
    await repos.alerts.insert(alert({ alertId: 'RECENT', timestamp: minutesAgo(10) }), 'LIVE');
    const ch = channelsOf();
    const engine = engineOf(ch);
    await engine.run();
    expect(ch.SLACK.sent.map((m) => m.alertId)).toEqual(['RECENT']);
    // an alert dated after the watermark qualifies even if it is older than the max age window would allow later
    await repos.alerts.insert(alert({ alertId: 'NEW', timestamp: new Date(Date.now() + 5_000).toISOString() }), 'LIVE');
    await engine.run();
    expect(ch.SLACK.sent.map((m) => m.alertId)).toEqual(['RECENT', 'NEW']);
    expect((await logOf()).some((e) => e.alertId === 'OLD')).toBe(false);
  });

  it('suppresses the same service + anomaly type inside the dedup window', async () => {
    const repos = getRepositories();
    await repos.alerts.insert(alert({ alertId: 'D1', anomalyType: 'Same', timestamp: minutesAgo(5) }), 'LIVE');
    await repos.alerts.insert(alert({ alertId: 'D2', anomalyType: 'Same', timestamp: minutesAgo(1) }), 'LIVE');
    await repos.alerts.insert(alert({ alertId: 'D3', anomalyType: 'Same', service: 'payments', timestamp: minutesAgo(3) }), 'LIVE');
    const ch = channelsOf();
    await engineOf(ch).run();
    // newest first: D2 wins, D1 (same service + type) is suppressed on all three channels; D3 is another service
    expect(ch.SLACK.sent.map((m) => m.alertId).sort()).toEqual(['D2', 'D3']);
    const dedup = (await logOf()).filter((e) => e.status === 'SKIPPED_DEDUP');
    expect(dedup.map((e) => e.alertId)).toEqual(['D1', 'D1', 'D1']);
    expect(dedup[0].error).toContain('within 30 min');
  });

  it('a dedup window of 0 disables the type-level suppression', async () => {
    const repos = getRepositories();
    await repos.notifications.updateSettings({ dedupWindowMinutes: 0 }, 'test');
    await repos.alerts.insert(alert({ anomalyType: 'Same' }), 'LIVE');
    await repos.alerts.insert(alert({ anomalyType: 'Same' }), 'LIVE');
    const ch = channelsOf();
    await engineOf(ch).run();
    expect(ch.SLACK.sent).toHaveLength(2);
  });

  it('enforces the per-channel hourly cap with a SKIPPED_RATE_LIMIT entry', async () => {
    const repos = getRepositories();
    await repos.notifications.updateSettings({ maxPerHourPerChannel: 2 }, 'test');
    for (let i = 0; i < 4; i++) await repos.alerts.insert(alert(), 'LIVE');
    const ch = channelsOf();
    await engineOf(ch).run();
    expect(ch.SLACK.sent).toHaveLength(2);
    const limited = (await logOf()).filter((e) => e.status === 'SKIPPED_RATE_LIMIT' && e.channel === 'SLACK');
    expect(limited).toHaveLength(2);
    expect(limited[0].error).toContain('rate limit');
  });

  it('two engines racing send exactly once per channel', async () => {
    const repos = getRepositories();
    await repos.alerts.insert(alert({ alertId: 'RACE' }), 'LIVE');
    const ch1 = channelsOf();
    const ch2 = channelsOf();
    await Promise.all([engineOf(ch1).run(), engineOf(ch2).run()]);
    expect(ch1.SLACK.sent.length + ch2.SLACK.sent.length).toBe(1);
    const sent = (await logOf()).filter((e) => e.status === 'SENT');
    expect(sent).toHaveLength(1);
  });

  it('records FAILED with a redacted error and the attempts made', async () => {
    await getRepositories().alerts.insert(alert(), 'LIVE');
    const ch = channelsOf({ SLACK: new FakeChannel('SLACK', true, 'HTTP 503') });
    await engineOf(ch).run();
    const e = (await logOf()).find((x) => x.channel === 'SLACK');
    expect(e).toMatchObject({ status: 'FAILED', attempts: 3, error: 'HTTP 503' });
  });

  it('dry-run mode sends nothing and logs DRY_RUN for every channel, configured or not', async () => {
    await getRepositories().alerts.insert(alert(), 'LIVE');
    const ch = channelsOf();
    await engineOf(ch, { dryRun: true }).run();
    expect(ch.SLACK.sent).toHaveLength(0);
    const log = await logOf();
    expect(log.map((e) => e.status)).toEqual(['DRY_RUN', 'DRY_RUN', 'DRY_RUN']);
    expect(new Set(log.map((e) => e.channel))).toEqual(new Set(['EMAIL', 'SLACK', 'TEAMS']));
  });

  it('does nothing when no rule is enabled', async () => {
    const repos = getRepositories();
    await ensureDefaultRule(repos);
    await repos.notifications.updateRule('rule-default-critical-high', { enabled: false }, 'test');
    await repos.alerts.insert(alert(), 'LIVE');
    const ch = channelsOf();
    await engineOf(ch).run();
    expect(ch.SLACK.sent).toHaveLength(0);
  });

  it('honours a custom rule: service filter and channel subset', async () => {
    const repos = getRepositories();
    await ensureDefaultRule(repos);
    await repos.notifications.updateRule('rule-default-critical-high', { enabled: false }, 'test');
    await repos.notifications.createRule({
      name: 'payments only', enabled: true, minSeverity: 'LOW', services: ['payments'], anomalyTypes: [], channels: ['TEAMS'], createdBy: 't',
    });
    await repos.alerts.insert(alert({ service: 'main', severity: 'LOW' }), 'LIVE');
    await repos.alerts.insert(alert({ service: 'payments', severity: 'LOW' }), 'LIVE');
    const ch = channelsOf({ TEAMS: new FakeChannel('TEAMS') });
    await engineOf(ch).run();
    expect(ch.TEAMS.sent).toHaveLength(1);
    expect(ch.TEAMS.sent[0].service).toBe('payments');
    expect(ch.SLACK.sent).toHaveLength(0);
  });
});

describe('sendTest', () => {
  it('uses the real adapter and logs an isTest entry without creating an alert', async () => {
    const repos = getRepositories();
    const ch = channelsOf();
    const entry = await engineOf(ch).sendTest('SLACK', 'CRITICAL');
    expect(entry).toMatchObject({ status: 'SENT', isTest: true, alertId: null, ruleId: null });
    expect(ch.SLACK.sent[0].title).toBe('[TEST] Urbani Radar notification test');
    expect(ch.SLACK.sent[0].summary).toContain('SIMULATED');
    expect((await repos.alerts.query({})).total).toBe(0);
  });
  it('is dry-run under NOTIFICATIONS_DRY_RUN and honest when not configured', async () => {
    const ch = channelsOf();
    expect((await engineOf(ch, { dryRun: true }).sendTest('SLACK', 'HIGH')).status).toBe('DRY_RUN');
    expect(ch.SLACK.sent).toHaveLength(0);
    const e = await engineOf(ch).sendTest('EMAIL', 'HIGH');
    expect(e).toMatchObject({ status: 'SKIPPED_NOT_CONFIGURED', error: 'not delivered: channel not configured' });
  });
});
