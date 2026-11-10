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
