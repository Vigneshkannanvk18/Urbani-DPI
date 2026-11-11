import { describe, expect, it, vi } from 'vitest';
import { GetTopicAttributesCommand, PublishCommand } from '@aws-sdk/client-sns';
import {
  DeliveryError, SlackChannel, SmtpEmailChannel, SnsEmailChannel, TeamsChannel, type FetchLike, type RetryOptions,
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

  describe('checkConnection (read-only)', () => {
    const attrClient = (impl: () => Promise<{ Attributes?: Record<string, string> }>) => ({ send: vi.fn(impl) });
    it('reports confirmed and pending subscribers without publishing', async () => {
      const c = attrClient(async () => ({ Attributes: { SubscriptionsConfirmed: '2', SubscriptionsPending: '1', KmsMasterKeyId: 'alias/aws/sns' } }));
      const r = await new SnsEmailChannel(ARN, c, fast).checkConnection();
      expect(r).toMatchObject({ ok: true, topicName: 'urbani-alerts', subscriptionsConfirmed: 2, subscriptionsPending: 1, encrypted: true });
      expect(r.message).toContain('2 confirmed subscribers');
      expect(c.send.mock.calls[0][0]).toBeInstanceOf(GetTopicAttributesCommand);
      expect(c.send.mock.calls[0][0]).not.toBeInstanceOf(PublishCommand);
      expect(JSON.stringify(r)).not.toContain(ARN);
    });
    it('warns when nobody has confirmed or subscribed', async () => {
      const pending = await new SnsEmailChannel(ARN, attrClient(async () => ({ Attributes: { SubscriptionsConfirmed: '0', SubscriptionsPending: '3' } })), fast).checkConnection();
      expect(pending.ok).toBe(true);
      expect(pending.message).toContain('no subscriber has confirmed');
      const none = await new SnsEmailChannel(ARN, attrClient(async () => ({ Attributes: {} })), fast).checkConnection();
      expect(none.message).toContain('no e-mail subscribers');
    });
    it('turns AWS errors into a hint and never leaks the ARN', async () => {
      const denied = Object.assign(new Error(`User is not authorized to perform: SNS:GetTopicAttributes on resource: ${ARN}`), { name: 'AuthorizationErrorException' });
      const r = await new SnsEmailChannel(ARN, attrClient(async () => { throw denied; }), fast).checkConnection();
      expect(r.ok).toBe(false);
      expect(r.message).toContain('sns:GetTopicAttributes');
      expect(r.message).not.toContain(ARN);
      expect(r.message).toContain('[redacted-arn]');
    });
    it('does not call AWS when the channel is not configured', async () => {
      const c = attrClient(async () => ({}));
      const r = await new SnsEmailChannel(null, c, fast).checkConnection();
      expect(r).toMatchObject({ ok: false, message: 'ALERT_SNS_TOPIC_ARN is not set' });
      expect(c.send).not.toHaveBeenCalled();
    });
  });
  it('is not configured without a valid topic ARN', () => {
    expect(new SnsEmailChannel(null, null, fast).state()).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'ALERT_SNS_TOPIC_ARN is not set' });
    expect(new SnsEmailChannel('nonsense', client(async () => ({})), fast).isConfigured()).toBe(false);
    expect(new SnsEmailChannel(ARN, client(async () => ({})), fast).state()).toMatchObject({ status: 'CONFIGURED', destination: 'urbani-alerts' });
  });
});

describe('SmtpEmailChannel (Google Workspace)', () => {
  const opts = { host: 'smtp.gmail.com', from: 'Urbani Radar <alerts@urbani.io>', to: ['a@urbani.io', 'b@urbani.io'], user: 'alerts@urbani.io', password: 'abcd efgh ijkl mnop' };
  const transport = (send: () => Promise<{ messageId?: string }>, verify: () => Promise<unknown> = async () => true) => ({
    sendMail: vi.fn(send), verify: vi.fn(verify),
  });

  it('sends subject + text to every recipient and returns the message id', async () => {
    const t = transport(async () => ({ messageId: '<id-1@mail>' }));
    const res = await new SmtpEmailChannel(opts, t, fast).send({ ...msg, title: `line1\nline2` });
    expect(res).toEqual({ providerMessageId: '<id-1@mail>', attempts: 1 });
    const mail = t.sendMail.mock.calls[0][0] as { from: string; to: string[]; subject: string; text: string };
    expect(mail.to).toEqual(opts.to);
    expect(mail.from).toBe(opts.from);
    expect(mail.subject).not.toContain('\n');
    expect(mail.text).toContain('main');
  });

  it('retries network errors and 4xx replies, not permanent 5xx replies, and never leaks the password', async () => {
    const flaky = transport(async () => { throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); });
    await expect(new SmtpEmailChannel(opts, flaky, fast).send(msg)).rejects.toMatchObject({ attempts: 3 });
    const denied = transport(async () => { throw Object.assign(new Error(`535 bad credentials for ${opts.password}`), { responseCode: 535 }); });
    const err = await new SmtpEmailChannel(opts, denied, fast).send(msg).catch((e) => e as DeliveryError);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.attempts).toBe(1);
    expect(err.message).not.toContain(opts.password);
    expect(denied.sendMail).toHaveBeenCalledTimes(1);
  });

  it('reports what is missing and does not touch the transport when not configured', async () => {
    const t = transport(async () => ({}));
    expect(new SmtpEmailChannel({ ...opts, host: null }, t, fast).state()).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'SMTP_HOST is not set' });
    expect(new SmtpEmailChannel({ ...opts, to: [] }, t, fast).state().reason).toBe('ALERT_EMAIL_TO (or ALERT_EMAIL_ROLES) is not set');
    expect(new SmtpEmailChannel({ ...opts, to: ['not-an-address'] }, t, fast).state().reason).toBe('ALERT_EMAIL_TO contains an invalid address');
    expect(new SmtpEmailChannel({ ...opts, from: 'nonsense' }, t, fast).state().reason).toContain('SMTP_FROM');
    const ok = new SmtpEmailChannel(opts, t, fast).state();
    expect(ok).toMatchObject({ status: 'CONFIGURED', destination: 'smtp.gmail.com (2 fixed recipients)' });
    await expect(new SmtpEmailChannel({ ...opts, to: [] }, t, fast).send(msg)).rejects.toMatchObject({ attempts: 0 });
    expect(t.sendMail).not.toHaveBeenCalled();
  });

  it('sends to the active users of the configured roles plus fixed recipients, de-duplicated, skipping undeliverable addresses', async () => {
    const t = transport(async () => ({ messageId: 'r1' }));
    const resolve = vi.fn(async (roles: string[]) => {
      expect(roles).toEqual(['SUPER_ADMIN', 'QA_OPERATOR', 'INFRA_ADMIN']);
      return ['Boss@Urbani.io', 'admin@urbani.local', 'a@urbani.io', 'qa@urbani.io'];
    });
    const c = new SmtpEmailChannel(
      { ...opts, toRoles: ['SUPER_ADMIN', 'QA_OPERATOR', 'INFRA_ADMIN'], resolveRoleRecipients: resolve }, t, fast,
    );
    await c.send(msg);
    const mail = t.sendMail.mock.calls[0][0] as { to: string[] };
    expect(mail.to).toEqual(['a@urbani.io', 'b@urbani.io', 'Boss@Urbani.io', 'qa@urbani.io']);
    expect(c.state().destination).toContain('users with role SUPER_ADMIN, QA_OPERATOR, INFRA_ADMIN');
  });

  it('fails clearly (and does not call SMTP) when no role user has a deliverable address', async () => {
    const t = transport(async () => ({}));
    const c = new SmtpEmailChannel(
      { ...opts, to: [], toRoles: ['SUPER_ADMIN'], resolveRoleRecipients: async () => ['admin@urbani.local'] }, t, fast,
    );
    await expect(c.send(msg)).rejects.toMatchObject({ attempts: 0, message: expect.stringContaining('no deliverable recipients') });
    expect(t.sendMail).not.toHaveBeenCalled();
  });

  describe('checkConnection', () => {
    it('verifies the login without sending anything', async () => {
      const t = transport(async () => ({}));
      const r = await new SmtpEmailChannel(opts, t, fast).checkConnection();
      expect(r.ok).toBe(true);
      expect(r.message).toContain('2 recipients');
      expect(t.verify).toHaveBeenCalledTimes(1);
      expect(t.sendMail).not.toHaveBeenCalled();
    });
    it('turns an auth failure into a hint and never leaks the password', async () => {
      const t = transport(async () => ({}), async () => { throw Object.assign(new Error(`Invalid login ${opts.password}`), { code: 'EAUTH', responseCode: 535 }); });
      const r = await new SmtpEmailChannel(opts, t, fast).checkConnection();
      expect(r.ok).toBe(false);
      expect(r.message).toContain('app password');
      expect(r.message).not.toContain(opts.password);
    });
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
