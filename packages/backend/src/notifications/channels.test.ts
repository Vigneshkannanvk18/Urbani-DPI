import { describe, expect, it, vi } from 'vitest';
import { PublishCommand } from '@aws-sdk/client-sns';
import {
  DeliveryError, SlackChannel, SnsEmailChannel, TeamsChannel, type FetchLike, type RetryOptions,
} from './channels';
import { buildAllowList } from './guard';
import { testMessage, type NotificationMessage } from './message';

const allow = buildAllowList(null);
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/SECRETSECRET';
const TEAMS_URL = 'https://contoso.webhook.office.com/webhookb2/SECRETTEAMS';
const fast: RetryOptions = { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 50, sleep: async () => undefined };

const msg: NotificationMessage = {
  title: '[CRITICAL] main: DatabaseConnectionTimeout',
  severity: 'CRITICAL',
  service: 'main',
  environment: 'qa',
  anomalyType: 'DatabaseConnectionTimeout',
  summary: 'Pool exhausted',
  probableCause: 'Unclosed sessions',
  confidence: '85% (derived)',
  timestamp: '2026-11-06T10:00:00.000Z',
  link: 'https://dash.example.com/alerts/ALT-1',
  isTest: false,
  alertId: 'ALT-1',
};

const ok = (status: number) => ({ status, text: async () => 'ok' });
const fetchSeq = (...statuses: number[]) => {
  const fn = vi.fn(async () => ok(statuses[Math.min(fn.mock.calls.length - 1, statuses.length - 1)]));
  return fn as unknown as FetchLike & ReturnType<typeof vi.fn>;
};

describe('SlackChannel', () => {
  it('posts text + blocks including the deep link and (derived) confidence', async () => {
    const f = fetchSeq(200);
    const res = await new SlackChannel(SLACK_URL, allow, f, fast).send(msg);
    expect(res.attempts).toBe(1);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe(SLACK_URL);
    expect(init.redirect).toBe('manual');
    const body = JSON.parse(init.body);
    expect(body.text).toContain('Severity: CRITICAL');
    expect(body.text).toContain('(derived)');
    expect(body.blocks[0].type).toBe('header');
    expect(JSON.stringify(body.blocks)).toContain('https://dash.example.com/alerts/ALT-1');
  });

  it('omits the link when none is configured', async () => {
    const f = fetchSeq(200);
    await new SlackChannel(SLACK_URL, allow, f, fast).send({ ...msg, link: null });
    expect((f as any).mock.calls[0][1].body).not.toContain('Open in dashboard');
  });

  it('retries 5xx up to 3 attempts then fails with attempts=3', async () => {
    const f = fetchSeq(500, 502, 503);
    await expect(new SlackChannel(SLACK_URL, allow, f, fast).send(msg)).rejects.toMatchObject({ attempts: 3, message: 'HTTP 503' });
    expect((f as any).mock.calls).toHaveLength(3);
  });

  it('succeeds on a retry after a 5xx', async () => {
    const f = fetchSeq(500, 200);
    const res = await new SlackChannel(SLACK_URL, allow, f, fast).send(msg);
    expect(res.attempts).toBe(2);
  });

  it('does not retry a 4xx', async () => {
    const f = fetchSeq(404);
    await expect(new SlackChannel(SLACK_URL, allow, f, fast).send(msg)).rejects.toMatchObject({ attempts: 1, message: 'HTTP 404' });
    expect((f as any).mock.calls).toHaveLength(1);
  });

  it('retries network errors and redacts the URL from the error', async () => {
    const f = vi.fn(async () => {
      throw new Error(`getaddrinfo ENOTFOUND for ${SLACK_URL}`);
    }) as unknown as FetchLike;
    const err = await new SlackChannel(SLACK_URL, allow, f, fast).send(msg).catch((e) => e as DeliveryError);
    expect(err).toBeInstanceOf(DeliveryError);
    expect((err as DeliveryError).attempts).toBe(3);
    expect((err as DeliveryError).message).not.toContain('SECRETSECRET');
    expect((err as DeliveryError).message).not.toContain('hooks.slack.com');
  });

  it('times out a hanging request and retries', async () => {
    const f = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    ) as unknown as FetchLike;
    const err = (await new SlackChannel(SLACK_URL, allow, f, { ...fast, timeoutMs: 10 }).send(msg).catch((e) => e)) as DeliveryError;
    expect(err.attempts).toBe(3);
    expect(err.message).toContain('timed out');
  });

  it('is NOT configured for a disallowed host and never calls fetch', async () => {
    const f = fetchSeq(200);
    const ch = new SlackChannel('https://evil.example.com/hook', allow, f, fast);
    expect(ch.isConfigured()).toBe(false);
    expect(ch.state()).toMatchObject({ status: 'NOT_CONFIGURED' });
    expect(JSON.stringify(ch.state())).not.toContain('evil.example.com');
    await expect(ch.send(msg)).rejects.toBeInstanceOf(DeliveryError);
    expect((f as any).mock.calls).toHaveLength(0);
  });

  it('reports the masked host for a configured webhook, never the URL', () => {
    const s = new SlackChannel(SLACK_URL, allow, fetchSeq(200), fast).state();
    expect(s).toEqual({ status: 'CONFIGURED', destination: 'hooks.slack.com', reason: null });
  });
});

describe('TeamsChannel', () => {
  it('sends an Adaptive Card message by default', async () => {
    const f = fetchSeq(202);
    await new TeamsChannel(TEAMS_URL, allow, f, 'adaptive', fast).send(msg);
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body.type).toBe('message');
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = body.attachments[0].content;
    expect(card.type).toBe('AdaptiveCard');
    expect(JSON.stringify(card)).toContain('85% (derived)');
    expect(card.actions[0].url).toBe(msg.link);
  });

  it('supports the legacy MessageCard format', async () => {
    const f = fetchSeq(200);
    await new TeamsChannel(TEAMS_URL, allow, f, 'messagecard', fast).send(msg);
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body['@type']).toBe('MessageCard');
    expect(body.sections[0].facts.some((x: { name: string }) => x.name === 'Service')).toBe(true);
  });

  it('masks the tenant label in its status', () => {
    expect(new TeamsChannel(TEAMS_URL, allow, fetchSeq(200), 'adaptive', fast).state().destination).toBe('***.webhook.office.com');
  });

  it('is not configured when the URL is unset', () => {
    const s = new TeamsChannel(null, allow, fetchSeq(200), 'adaptive', fast).state();
    expect(s).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'TEAMS_WEBHOOK_URL is not set' });
  });
});

describe('SnsEmailChannel', () => {
  const ARN = 'arn:aws:sns:us-east-1:123456789012:urbani-alerts';
  const client = (impl: () => Promise<{ MessageId?: string }>) => ({ send: vi.fn(impl) });

  it('publishes subject + text to the topic and returns the MessageId', async () => {
    const c = client(async () => ({ MessageId: 'm-1' }));
    const res = await new SnsEmailChannel(ARN, c, fast).send(msg);
    expect(res).toEqual({ providerMessageId: 'm-1', attempts: 1 });
    const cmd = c.send.mock.calls[0][0] as PublishCommand;
    expect(cmd).toBeInstanceOf(PublishCommand);
    expect(cmd.input.TopicArn).toBe(ARN);
    expect(cmd.input.Subject).toBe(msg.title);
    expect(cmd.input.Message).toContain('Probable cause: Unclosed sessions');
    expect(cmd.input.Message).toContain('Open in dashboard: https://dash.example.com/alerts/ALT-1');
  });

  it('keeps the subject on one line and within 100 characters', async () => {
    const c = client(async () => ({}));
    await new SnsEmailChannel(ARN, c, fast).send({ ...msg, title: `line1\nline2 ${'x'.repeat(200)}` });
    const subject = (c.send.mock.calls[0][0] as PublishCommand).input.Subject as string;
    expect(subject).not.toContain('\n');
    expect(subject.length).toBeLessThanOrEqual(100);
  });

  it('retries 5xx and does not retry 4xx', async () => {
    const e500 = Object.assign(new Error('boom'), { name: 'InternalFailure', $metadata: { httpStatusCode: 500 } });
    const c5 = client(async () => {
      throw e500;
    });
    await expect(new SnsEmailChannel(ARN, c5, fast).send(msg)).rejects.toMatchObject({ attempts: 3 });
    expect(c5.send).toHaveBeenCalledTimes(3);
    const e403 = Object.assign(new Error('denied'), { name: 'AuthorizationError', $metadata: { httpStatusCode: 403 } });
    const c4 = client(async () => {
      throw e403;
    });
    await expect(new SnsEmailChannel(ARN, c4, fast).send(msg)).rejects.toMatchObject({ attempts: 1 });
    expect(c4.send).toHaveBeenCalledTimes(1);
  });

  it('is not configured without a valid topic ARN', () => {
    expect(new SnsEmailChannel(null, null, fast).state()).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'ALERT_SNS_TOPIC_ARN is not set' });
    expect(new SnsEmailChannel('nonsense', client(async () => ({})), fast).isConfigured()).toBe(false);
    expect(new SnsEmailChannel(ARN, client(async () => ({})), fast).state()).toMatchObject({ status: 'CONFIGURED', destination: 'urbani-alerts' });
  });
});

describe('test message', () => {
  it('is clearly labelled and marked SIMULATED', () => {
    const m = testMessage('CRITICAL', 'https://dash.example.com/', '2026-11-06T10:00:00.000Z');
    expect(m.title).toBe('[TEST] Urbani Radar notification test');
    expect(m.summary).toContain('SIMULATED');
    expect(m.isTest).toBe(true);
    expect(m.alertId).toBeNull();
    expect(m.link).toBe('https://dash.example.com/notifications');
  });
});
