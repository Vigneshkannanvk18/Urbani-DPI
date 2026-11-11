import { GetTopicAttributesCommand, PublishCommand } from '@aws-sdk/client-sns';
import type { ChannelConfigStatus, NotificationChannelName } from '@urbani/shared';
import { maskHost, redactText, validateWebhookUrl, type UrlCheck } from './guard';
import { plainText, type NotificationMessage } from './message';

/**
 * Channel adapters (DPI 2 item 6): one interface, three implementations. They never log or return a webhook URL.
 */
export interface SendResult {
  providerMessageId: string | null;
  attempts: number;
}

/** Thrown by send(); the message is already redacted and `attempts` is how many tries were made. */
export class DeliveryError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export interface ChannelState {
  status: Exclude<ChannelConfigStatus, 'DRY_RUN'>;
  /** Masked destination; never the URL. */
  destination: string | null;
  reason: string | null;
}

export interface NotificationChannel {
  readonly name: NotificationChannelName;
  isConfigured(): boolean;
  state(): ChannelState;
  send(message: NotificationMessage): Promise<SendResult>;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}
export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  timeoutMs: 10_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A failure of one attempt: retryable = 5xx, network error or timeout. 4xx are not retried. */
class AttemptFailure extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/** Runs op up to maxAttempts times with exponential backoff and a per-attempt timeout. */
async function withRetries<T>(
  op: (signal: AbortSignal) => Promise<T>,
  o: RetryOptions,
  secrets: Array<string | null | undefined>,
): Promise<{ value: T; attempts: number }> {
  let last = 'unknown error';
  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, o.timeoutMs);
    try {
      return { value: await op(ctl.signal), attempts: attempt };
    } catch (err) {
      let retryable = true;
      if (err instanceof AttemptFailure) {
        retryable = err.retryable;
        last = err.message;
      } else if (timedOut) {
        last = `timed out after ${o.timeoutMs} ms`;
      } else {
        last = `${(err as Error)?.name ?? 'Error'}: ${(err as Error)?.message ?? 'request failed'}`;
      }
      last = redactText(last, secrets);
      if (!retryable || attempt === o.maxAttempts) throw new DeliveryError(last, attempt);
      await o.sleep(o.baseDelayMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new DeliveryError(last, o.maxAttempts);
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number; text(): Promise<string> }>;

// ---------------------------------------------------------------- webhook base
abstract class WebhookChannel implements NotificationChannel {
  abstract readonly name: NotificationChannelName;
  private readonly check: UrlCheck;
  constructor(
    private readonly url: string | null,
    allowList: string[],
    protected readonly fetchImpl: FetchLike,
    private readonly retry: RetryOptions,
    private readonly envName: string,
  ) {
    this.check = validateWebhookUrl(url, allowList);
  }
  isConfigured(): boolean {
    return this.check.ok;
  }
  state(): ChannelState {
    if (this.check.ok) return { status: 'CONFIGURED', destination: maskHost(this.check.host), reason: null };
    return {
      status: 'NOT_CONFIGURED',
      destination: null,
      reason: this.url ? `${this.envName} rejected: ${this.check.reason}` : `${this.envName} is not set`,
    };
  }
  protected abstract payload(m: NotificationMessage): unknown;
  async send(m: NotificationMessage): Promise<SendResult> {
    if (!this.check.ok || !this.url) throw new DeliveryError('channel not configured', 0);
    const url = this.url;
    const body = JSON.stringify(this.payload(m));
    const { attempts } = await withRetries(
      async (signal) => {
        const res = await this.fetchImpl(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal, redirect: 'manual',
        });
        if (res.status >= 200 && res.status < 300) return;
        throw new AttemptFailure(`HTTP ${res.status}`, res.status >= 500);
      },
      this.retry,
      [url],
    );
    return { providerMessageId: null, attempts };
  }
}

const SEVERITY_EMOJI: Record<string, string> = { CRITICAL: ':rotating_light:', HIGH: ':red_circle:', MEDIUM: ':large_orange_circle:', LOW: ':large_yellow_circle:' };

export class SlackChannel extends WebhookChannel {
  readonly name = 'SLACK' as const;
  constructor(url: string | null, allowList: string[], fetchImpl: FetchLike, retry: RetryOptions = DEFAULT_RETRY) {
    super(url, allowList, fetchImpl, retry, 'SLACK_WEBHOOK_URL');
  }
  protected payload(m: NotificationMessage): unknown {
    const fields = [
      `*Severity:* ${m.severity}`,
      `*Service:* ${m.service}`,
      `*Environment:* ${m.environment}`,
      `*Anomaly type:* ${m.anomalyType}`,
      `*Time:* ${m.timestamp}`,
      ...(m.confidence ? [`*Confidence:* ${m.confidence}`] : []),
    ];
    const blocks: unknown[] = [
      { type: 'header', text: { type: 'plain_text', text: m.title.slice(0, 150) } },
      { type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) },
      { type: 'section', text: { type: 'mrkdwn', text: `*Summary:* ${m.summary}${m.probableCause ? `\n*Probable cause:* ${m.probableCause}` : ''}` } },
    ];
    if (m.link) {
      blocks.push({
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in dashboard' }, url: m.link }],
      });
    }
    return { text: `${SEVERITY_EMOJI[m.severity] ?? ''} ${plainText(m)}`.trim(), blocks };
  }
}

const TEAMS_COLOR: Record<string, string> = { CRITICAL: 'B71C1C', HIGH: 'E53935', MEDIUM: 'FB8C00', LOW: 'FDD835' };
export type TeamsFormat = 'adaptive' | 'messagecard';

export class TeamsChannel extends WebhookChannel {
  readonly name = 'TEAMS' as const;
  constructor(
    url: string | null,
    allowList: string[],
    fetchImpl: FetchLike,
    private readonly format: TeamsFormat = 'adaptive',
    retry: RetryOptions = DEFAULT_RETRY,
  ) {
    super(url, allowList, fetchImpl, retry, 'TEAMS_WEBHOOK_URL');
  }
  protected payload(m: NotificationMessage): unknown {
    const facts: Array<[string, string]> = [
      ['Severity', m.severity],
      ['Service', m.service],
      ['Environment', m.environment],
      ['Anomaly type', m.anomalyType],
      ['Time', m.timestamp],
      ...(m.confidence ? ([['Confidence', m.confidence]] as Array<[string, string]>) : []),
    ];
    if (this.format === 'messagecard') {
      return {
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        summary: m.title,
        themeColor: TEAMS_COLOR[m.severity] ?? '808080',
        title: m.title,
        sections: [
          {
            facts: facts.map(([name, value]) => ({ name, value })),
            text: `${m.summary}${m.probableCause ? `\n\n**Probable cause:** ${m.probableCause}` : ''}`,
          },
        ],
        ...(m.link ? { potentialAction: [{ '@type': 'OpenUri', name: 'Open in dashboard', targets: [{ os: 'default', uri: m.link }] }] } : {}),
      };
    }
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true },
              { type: 'FactSet', facts: facts.map(([title, value]) => ({ title, value })) },
              { type: 'TextBlock', text: m.summary, wrap: true },
              ...(m.probableCause ? [{ type: 'TextBlock', text: `Probable cause: ${m.probableCause}`, wrap: true, isSubtle: true }] : []),
            ],
            ...(m.link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in dashboard', url: m.link }] } : {}),
          },
        },
      ],
    };
  }
}

// ---------------------------------------------------------------- SNS (e-mail)
export interface SnsLike {
  send(
    command: PublishCommand | GetTopicAttributesCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ MessageId?: string; Attributes?: Record<string, string> }>;
}

/** Result of a read-only connection check (no message is published). Never contains the topic ARN. */
export interface SnsConnectionCheck {
  ok: boolean;
  topicName: string | null;
  /** Subscribers who confirmed. Only these receive e-mail. */
  subscriptionsConfirmed: number | null;
  /** Subscribers who have not yet clicked the AWS confirmation e-mail. */
  subscriptionsPending: number | null;
  encrypted: boolean | null;
  /** Why the check failed, or what to do next. */
  message: string;
}

/** E-mail through an Amazon SNS topic. Subscriptions (addresses) live in AWS and must be confirmed by each recipient. */
export class SnsEmailChannel implements NotificationChannel {
  readonly name = 'EMAIL' as const;
  constructor(
    private readonly topicArn: string | null,
    private readonly client: SnsLike | null,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
  ) {}
  isConfigured(): boolean {
    return Boolean(this.topicArn && this.client && /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[\w.-]+$/.test(this.topicArn));
  }
  state(): ChannelState {
    if (!this.topicArn) return { status: 'NOT_CONFIGURED', destination: null, reason: 'ALERT_SNS_TOPIC_ARN is not set' };
    if (!this.isConfigured()) return { status: 'NOT_CONFIGURED', destination: null, reason: 'ALERT_SNS_TOPIC_ARN is not a valid SNS topic ARN' };
    return { status: 'CONFIGURED', destination: this.topicArn.split(':').pop() ?? null, reason: null };
  }
  /**
   * Read-only connection test: GetTopicAttributes. Proves the credentials, region and topic ARN work and reports how many
   * subscribers confirmed. Publishes nothing. Needs sns:GetTopicAttributes on the topic. Never throws and never returns the ARN.
   */
  async checkConnection(): Promise<SnsConnectionCheck> {
    const fail = (message: string): SnsConnectionCheck => ({
      ok: false, topicName: null, subscriptionsConfirmed: null, subscriptionsPending: null, encrypted: null, message,
    });
    if (!this.isConfigured() || !this.client) return fail(this.state().reason ?? 'channel not configured');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.retry.timeoutMs);
    try {
      const out = await this.client.send(new GetTopicAttributesCommand({ TopicArn: this.topicArn as string }), { abortSignal: ac.signal });
      const a = out.Attributes ?? {};
      const confirmed = Number(a.SubscriptionsConfirmed ?? 0);
      const pending = Number(a.SubscriptionsPending ?? 0);
      const message =
        confirmed > 0
          ? `Connected. ${confirmed} confirmed subscriber${confirmed === 1 ? '' : 's'}${pending ? `, ${pending} waiting to confirm` : ''}.`
          : pending > 0
            ? `Connected, but no subscriber has confirmed yet (${pending} pending). Ask them to click the AWS confirmation e-mail.`
            : 'Connected, but the topic has no e-mail subscribers. Subscribe an address in the AWS console or with ALERT_EMAILS.';
      return {
        ok: true,
        topicName: this.topicArn?.split(':').pop() ?? null,
        subscriptionsConfirmed: confirmed,
        subscriptionsPending: pending,
        encrypted: Boolean(a.KmsMasterKeyId),
        message,
      };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const name = e.name ?? 'Error';
      const hint =
        name === 'AuthorizationErrorException' || name === 'AccessDeniedException'
          ? ' The backend role needs sns:GetTopicAttributes on the topic.'
          : name === 'NotFoundException' || name === 'NotFound'
            ? ' The topic does not exist in this region and account; check ALERT_SNS_TOPIC_ARN and AWS_REGION.'
            : name === 'CredentialsProviderError'
              ? ' No AWS credentials found; use a task role or set AWS credentials.'
              : '';
      return fail(`${name}: ${redactText(e.message ?? 'check failed')}${hint}`.replace(/arn:aws[a-z-]*:[^\s"')]+/gi, '[redacted-arn]'));
    } finally {
      clearTimeout(timer);
    }
  }

  async send(m: NotificationMessage): Promise<SendResult> {
    if (!this.isConfigured() || !this.client) throw new DeliveryError('channel not configured', 0);
    const client = this.client;
    const subject = m.title.replace(/[\r\n]+/g, ' ').slice(0, 100);
    const { value, attempts } = await withRetries(
      async (signal) => {
        try {
          return await client.send(
            new PublishCommand({ TopicArn: this.topicArn as string, Subject: subject, Message: plainText(m) }),
            { abortSignal: signal },
          );
        } catch (err) {
          const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
          const code = e.$metadata?.httpStatusCode;
          if (signal.aborted) throw err;
          throw new AttemptFailure(`${e.name ?? 'Error'}: ${e.message ?? 'publish failed'}`, code === undefined || code >= 500);
        }
      },
      this.retry,
      [this.topicArn],
    );
    return { providerMessageId: value.MessageId ?? null, attempts };
  }
}

// ---------------------------------------------------------------- SMTP (e-mail, Google Workspace)
/** The slice of a nodemailer transport this channel needs; tests inject a fake. */
export interface MailTransportLike {
  sendMail(mail: { from: string; to: string[]; subject: string; text: string }): Promise<{ messageId?: string }>;
  verify(): Promise<unknown>;
}

export interface SmtpEmailOptions {
  host: string | null;
  from: string | null;
  /** Fixed recipients (ALERT_EMAIL_TO). */
  to: string[];
  /** RBAC roles whose active users also receive the mail (ALERT_EMAIL_ROLES). Needs resolveRoleRecipients. */
  toRoles?: string[];
  /** Returns the e-mail addresses of active users holding any of the roles. Called on every send. */
  resolveRoleRecipients?: (roles: string[]) => Promise<string[]>;
  user: string | null;
  /** Passed to redaction so an SMTP error can never echo the password. */
  password: string | null;
}

/** Domains that can never receive mail (seed/demo accounts such as admin@urbani.local). */
const UNDELIVERABLE_DOMAIN = /\.(local|localhost|test|example|invalid)$/i;

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
/** Accepts `alerts@urbani.io` or `Urbani Radar <alerts@urbani.io>`. */
const FROM_RE = /^(?:[^<>\r\n]*<[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+>|[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+)$/;

/**
 * E-mail over SMTP, intended for Google Workspace (smtp.gmail.com with an app password, or smtp-relay.gmail.com).
 * Recipients come from ALERT_EMAIL_TO only (never from API input). Never logs or returns the password.
 */
export class SmtpEmailChannel implements NotificationChannel {
  readonly name = 'EMAIL' as const;
  constructor(
    private readonly o: SmtpEmailOptions,
    private readonly transport: MailTransportLike | null,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
  ) {}
  private problem(): string | null {
    if (!this.o.host) return 'SMTP_HOST is not set';
    if (!this.o.from || !FROM_RE.test(this.o.from)) return 'SMTP_FROM (or SMTP_USER) is not a valid sender address';
    if (this.o.to.length === 0 && !this.roles().length) return 'ALERT_EMAIL_TO (or ALERT_EMAIL_ROLES) is not set';
    if (!this.o.to.every((a) => EMAIL_RE.test(a))) return 'ALERT_EMAIL_TO contains an invalid address';
    return null;
  }
  private roles(): string[] {
    return this.o.resolveRoleRecipients ? this.o.toRoles ?? [] : [];
  }
  /** Fixed recipients plus the active users of the configured roles; de-duplicated, deliverable addresses only. */
  async recipients(): Promise<string[]> {
    const fromRoles = this.roles().length && this.o.resolveRoleRecipients ? await this.o.resolveRoleRecipients(this.roles()) : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [...this.o.to, ...fromRoles]) {
      const a = raw.trim();
      const key = a.toLowerCase();
      if (!EMAIL_RE.test(a) || UNDELIVERABLE_DOMAIN.test(a) || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  }
  isConfigured(): boolean {
    return this.problem() === null && this.transport !== null;
  }
  state(): ChannelState {
    const p = this.problem();
    if (p) return { status: 'NOT_CONFIGURED', destination: null, reason: p };
    const who = [
      ...(this.o.to.length ? [`${this.o.to.length} fixed recipient${this.o.to.length === 1 ? '' : 's'}`] : []),
      ...(this.roles().length ? [`users with role ${this.roles().join(', ')}`] : []),
    ].join(' + ');
    return { status: 'CONFIGURED', destination: `${this.o.host} (${who})`, reason: null };
  }
  /** Read-only: SMTP connect + STARTTLS + auth (nodemailer verify). Sends nothing. */
  async checkConnection(): Promise<SnsConnectionCheck> {
    const fail = (message: string): SnsConnectionCheck => ({
      ok: false, topicName: null, subscriptionsConfirmed: null, subscriptionsPending: null, encrypted: null, message,
    });
    if (!this.isConfigured() || !this.transport) return fail(this.state().reason ?? 'channel not configured');
    try {
      await Promise.race([
        this.transport.verify(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${this.retry.timeoutMs} ms`)), this.retry.timeoutMs).unref()),
      ]);
      const n = (await this.recipients()).length;
      return {
        ok: true, topicName: this.o.host, subscriptionsConfirmed: n, subscriptionsPending: 0, encrypted: true,
        message: n > 0
          ? `Connected to ${this.o.host} and authenticated. Alerts go to ${n} recipient${n === 1 ? '' : 's'}.`
          : `Connected to ${this.o.host} and authenticated, but there are no deliverable recipients yet. Add users with the configured roles (real e-mail addresses) or set ALERT_EMAIL_TO.`,
      };
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; message?: string };
      const hint =
        e.code === 'EAUTH' || e.responseCode === 535
          ? ' Authentication failed. For Gmail SMTP use an app password (2-Step Verification on); for smtp-relay.gmail.com check the relay rule in Google Admin.'
          : e.code === 'ESOCKET' || e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT'
            ? ' Cannot reach the SMTP server; check SMTP_HOST/SMTP_PORT and outbound access on that port.'
            : '';
      return fail(`${redactText(e.message ?? 'check failed', [this.o.password, this.o.user])}${hint}`);
    }
  }
  async send(m: NotificationMessage): Promise<SendResult> {
    if (!this.isConfigured() || !this.transport || !this.o.from) throw new DeliveryError('channel not configured', 0);
    const transport = this.transport;
    const from = this.o.from;
    const subject = m.title.replace(/[\r\n]+/g, ' ').slice(0, 150);
    const to = await this.recipients();
    if (to.length === 0) {
      throw new DeliveryError('no deliverable recipients: no active user with a real e-mail address has a configured role, and ALERT_EMAIL_TO is empty', 0);
    }
    const { value, attempts } = await withRetries(
      async (signal) => {
        try {
          const res = await Promise.race([
            transport.sendMail({ from, to, subject, text: plainText(m) }),
            new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
          ]);
          return res;
        } catch (err) {
          const e = err as { name?: string; message?: string; responseCode?: number };
          if (signal.aborted) throw err;
          // 5xx SMTP replies (bad auth, rejected recipient) are permanent; network errors and 4xx are transient.
          const permanent = e.responseCode !== undefined && e.responseCode >= 500;
          throw new AttemptFailure(`${e.name ?? 'Error'}: ${e.message ?? 'send failed'}`, !permanent);
        }
      },
      this.retry,
      [this.o.password, this.o.user],
    );
    return { providerMessageId: value.messageId ?? null, attempts };
  }
}
