import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  type ResultField,
} from '@aws-sdk/client-cloudwatch-logs';
import type { LogEntry, MetricSnapshot } from '@urbani/shared';
import type { CloudWatchAdapter, CloudWatchLogQuery, CloudWatchMetricQuery, WithMeta } from '../types';
import { mockMetrics, MOCK_NOTE } from '../mock/mockData';
import { parseLogLine } from '../live/logLineParser';
import { effectiveServices, filterLogEntries, sortLogEntries } from '../logFilter';
import { assertSafeRegex } from '../../lib/safeRegex';
import { ValidationError } from '../../lib/errors';
import { logger } from '../../lib/logger';

/**
 * CloudWatch Logs Insights adapter (DPI 2 item 4) — searches the FULL log stream of the
 * configured log groups. Selected only when LOGS_SOURCE=insights. NOT exercised against real
 * AWS in this repo (client access pending); unit-tested with a mocked SDK client.
 *
 * Honesty rules: a service without a configured log group, an access-denied group, or a timed-out
 * query is reported in the note and never shown as LIVE. If no requested service could be read the
 * result is WAITING_FOR_INTEGRATION with an empty list.
 */
export interface InsightsOptions {
  /** service -> log group name (from LOGS_INSIGHTS_LOG_GROUPS). */
  logGroups: Record<string, string>;
  /** Enabled services the UI may ask for. */
  services: string[];
  environment: string;
  timeoutMs: number;
  maxResults: number;
  pollIntervalMs?: number;
  /** Look-back used when no from/to is given. */
  defaultWindowHours?: number;
}

type InsightsClient = Pick<CloudWatchLogsClient, 'send'>;

type ServiceOutcome =
  | { service: string; ok: true; entries: LogEntry[]; matched: number | undefined; capped: boolean }
  | { service: string; ok: false; reason: string };

/** Escape a user string for use inside an Insights `/.../` regex literal (substring search). */
export function escapeInsightsLiteral(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&');
}

/** Insights regex literal body: only the delimiter and control characters need handling. */
function insightsRegexBody(pattern: string): string {
  return pattern.replace(/\\\//g, '/').replace(/\//g, '\\/');
}

function assertNoControlChars(s: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new ValidationError('Search text must not contain control characters.');
}

/**
 * Build the Insights query string from VALIDATED filters. User text is never concatenated raw:
 * substring text is regex-escaped, a user regex is length-checked, structure-checked and has its
 * delimiter escaped, and everything else comes from fixed constants or integers.
 */
export function buildInsightsQuery(q: CloudWatchLogQuery, maxResults: number, regexMaxLength = 200): string {
  const lines = ['fields @timestamp, @message'];
  if (q.search) {
    assertNoControlChars(q.search);
    if (q.regex) {
      assertSafeRegex(q.search, regexMaxLength);
      lines.push(`| filter @message like /(?i)${insightsRegexBody(q.search)}/`);
    } else {
      lines.push(`| filter @message like /(?i)${escapeInsightsLiteral(q.search)}/`);
    }
  }
  const limit = Math.max(1, Math.min(Math.floor(maxResults), 10_000));
  lines.push('| sort @timestamp desc', `| limit ${limit}`);
  return lines.join('\n');
}

/** Insights returns "YYYY-MM-DD HH:mm:ss.SSS" in UTC. */
function parseInsightsTimestamp(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CloudWatchLogsInsightsAdapter implements CloudWatchAdapter {
  readonly kind = 'CLOUDWATCH' as const;
  private readonly client: InsightsClient;

  constructor(
    private readonly opts: InsightsOptions,
    region = 'us-east-1',
    client?: InsightsClient,
  ) {
    this.client = client ?? new CloudWatchLogsClient({ region });
  }

  async getLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>> {
    const requested = effectiveServices(query).filter((s) => this.opts.services.includes(s));
    const targets = requested.length ? requested : this.opts.services;
    const limit = Math.min(query.limit ?? this.opts.maxResults, this.opts.maxResults);
    const scope = `Full CloudWatch stream via Logs Insights (log groups: ${
      targets.map((s) => this.opts.logGroups[s]).filter(Boolean).join(', ') || 'none configured'
    }). Default window: last ${this.opts.defaultWindowHours ?? 24} h when no date range is set. Levels are inferred from message text and applied after retrieval.`;

    const unconfigured = targets.filter((s) => !this.opts.logGroups[s]);
    const configured = targets.filter((s) => this.opts.logGroups[s]);
    // Validate inputs once (throws 400) before any AWS call.
    const queryString = buildInsightsQuery(query, limit);

    const outcomes = await Promise.all(configured.map((s) => this.runForService(s, queryString, query, limit)));
    const failed = outcomes.filter((o): o is Extract<ServiceOutcome, { ok: false }> => !o.ok);
    const okOutcomes = outcomes.filter((o): o is Extract<ServiceOutcome, { ok: true }> => o.ok);

    const problems = [
      ...unconfigured.map((s) => `${s}: no log group configured`),
      ...failed.map((f) => `${f.service}: ${f.reason}`),
    ];

    if (okOutcomes.length === 0) {
      return {
        meta: {
          source: 'WAITING_FOR_INTEGRATION',
          note: `Logs Insights is not available for the requested server(s). ${problems.join('; ') || 'No log groups configured (LOGS_INSIGHTS_LOG_GROUPS).'}`,
          truncated: false,
          windowCap: this.opts.maxResults,
          scope,
        },
        value: [],
      };
    }

    // Levels (inferred) and range are applied here; text/regex were pushed into the query.
    const merged = okOutcomes.flatMap((o) => o.entries);
    const filtered = sortLogEntries(
      filterLogEntries(merged, { levels: query.levels, level: query.level, startTime: query.startTime, endTime: query.endTime }),
      query.sort,
    );
    const capped = okOutcomes.some((o) => o.capped) || filtered.length > limit;
    return {
      meta: {
        source: 'LIVE',
        note: `Live CloudWatch Logs Insights.${problems.length ? ` Not searched: ${problems.join('; ')}.` : ''}`,
        truncated: capped,
        windowCap: this.opts.maxResults,
        scope,
      },
      value: filtered.slice(0, limit),
    };
  }

  private async runForService(
    service: string,
    queryString: string,
    q: CloudWatchLogQuery,
    limit: number,
  ): Promise<ServiceOutcome> {
    const nowS = Math.floor(Date.now() / 1000);
    const toMs = q.endTime ? Date.parse(q.endTime) : NaN;
    const fromMs = q.startTime ? Date.parse(q.startTime) : NaN;
    const endTime = Number.isNaN(toMs) ? nowS : Math.floor(toMs / 1000);
    const startTime = Number.isNaN(fromMs)
      ? endTime - (this.opts.defaultWindowHours ?? 24) * 3600
      : Math.floor(fromMs / 1000);
    try {
      const start = await this.client.send(
        new StartQueryCommand({
          logGroupNames: [this.opts.logGroups[service]],
          queryString,
          startTime,
          endTime: Math.max(endTime, startTime + 1),
          limit,
        }),
      );
      if (!start.queryId) return { service, ok: false, reason: 'query did not start' };

      const deadline = Date.now() + this.opts.timeoutMs;
      const interval = this.opts.pollIntervalMs ?? 1000;
      for (;;) {
        const res = await this.client.send(new GetQueryResultsCommand({ queryId: start.queryId }));
        if (res.status === 'Complete') {
          const entries = (res.results ?? [])
            .map((row) => this.toEntry(service, row))
            .filter((e): e is LogEntry => e !== null);
          const matched = res.statistics?.recordsMatched;
          return { service, ok: true, entries, matched, capped: (res.results?.length ?? 0) >= limit || (matched ?? 0) > (res.results?.length ?? 0) };
        }
        if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') {
          return { service, ok: false, reason: `query ${res.status.toLowerCase()}` };
        }
        if (Date.now() + interval > deadline) {
          return { service, ok: false, reason: `query timed out after ${this.opts.timeoutMs} ms` };
        }
        await sleep(interval);
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      logger.warn('Logs Insights query failed', { service, errorName: name });
      if (name === 'AccessDeniedException' || name === 'UnauthorizedException' || name === 'AccessDenied') {
        return { service, ok: false, reason: 'access denied to the log group (check IAM: logs:StartQuery, logs:GetQueryResults)' };
      }
      if (name === 'ResourceNotFoundException') return { service, ok: false, reason: 'log group not found' };
      if (name === 'LimitExceededException' || name === 'ThrottlingException') return { service, ok: false, reason: 'throttled by CloudWatch, retry shortly' };
      return { service, ok: false, reason: `query error (${name})` };
    }
  }

  private toEntry(service: string, row: ResultField[]): LogEntry | null {
    const field = (name: string) => row.find((f) => f.field === name)?.value;
    const message = field('@message');
    if (!message) return null;
    const ts = parseInsightsTimestamp(field('@timestamp'));
    return parseLogLine({ timestamp: ts, message }, { service, environment: this.opts.environment, fallbackMs: ts ? Date.parse(ts) : undefined }).entry;
  }

  /** Metrics are not served by this adapter; honest MOCK as in the live HTTP adapter. */
  async getMetrics(query: CloudWatchMetricQuery): Promise<WithMeta<MetricSnapshot[]>> {
    let items = [...mockMetrics];
    if (query.service) items = items.filter((m) => m.service === query.service);
    if (query.environment) items = items.filter((m) => m.environment === query.environment);
    if (query.limit) items = items.slice(0, query.limit);
    return { meta: { source: 'MOCK', note: `${MOCK_NOTE} (metrics not served by Logs Insights adapter)` }, value: items };
  }
}
