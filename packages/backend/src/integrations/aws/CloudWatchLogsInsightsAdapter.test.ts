import { describe, it, expect, vi } from 'vitest';
import { StartQueryCommand, GetQueryResultsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  CloudWatchLogsInsightsAdapter,
  buildInsightsQuery,
  escapeInsightsLiteral,
  type InsightsOptions,
} from './CloudWatchLogsInsightsAdapter';
import { ValidationError } from '../../lib/errors';

const OPTS: InsightsOptions = {
  logGroups: { main: '/aws/ecs/main/app', payments: '/aws/ecs/payments/app' },
  services: ['main', 'payments'],
  environment: 'qa',
  timeoutMs: 200,
  maxResults: 10,
  pollIntervalMs: 5,
};

const row = (ts: string, msg: string) => [
  { field: '@timestamp', value: ts },
  { field: '@message', value: msg },
  { field: '@ptr', value: 'ptr' },
];

/** Fake SDK client: records commands, answers by command type. */
function fakeClient(handlers: {
  start?: (input: any) => unknown;
  results?: (input: any, n: number) => unknown;
}) {
  const sent: any[] = [];
  let polls = 0;
  const send = vi.fn(async (cmd: any) => {
    sent.push(cmd);
    if (cmd instanceof StartQueryCommand) {
      const r = handlers.start ? handlers.start(cmd.input) : { queryId: 'q1' };
      if (r instanceof Error) throw r;
      return r;
    }
    if (cmd instanceof GetQueryResultsCommand) {
      const r = handlers.results ? handlers.results(cmd.input, ++polls) : { status: 'Complete', results: [] };
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error('unexpected command');
  });
  return { client: { send } as any, sent };
}

const named = (name: string) => Object.assign(new Error(name), { name });

describe('buildInsightsQuery', () => {
  it('escapes regex metacharacters and the delimiter in substring text', () => {
    expect(escapeInsightsLiteral('a.b/c*(d)')).toBe('a\\.b\\/c\\*\\(d\\)');
    const q = buildInsightsQuery({ search: 'a/b.c' }, 50);
    expect(q).toContain('| filter @message like /(?i)a\\/b\\.c/');
    expect(q).toContain('| sort @timestamp desc');
    expect(q).toContain('| limit 50');
  });

  it('cannot be broken out of by injected query syntax', () => {
    const q = buildInsightsQuery({ search: '/ | stats count(*) by @log //' }, 10);
    // The only newlines are the fixed pipeline separators: injected "|" stays inside the escaped literal.
    expect(q.split('\n')).toHaveLength(4);
    expect(q).not.toMatch(/\n\| stats/);
  });

  it('rejects control characters (newline injection)', () => {
    expect(() => buildInsightsQuery({ search: 'x\n| stats count(*)' }, 10)).toThrow(ValidationError);
  });

  it('validates user regex and escapes only the delimiter', () => {
    expect(buildInsightsQuery({ search: 'err(or)?/x', regex: true }, 10)).toContain('like /(?i)err(or)?\\/x/');
    expect(() => buildInsightsQuery({ search: '(a+)+$', regex: true }, 10)).toThrow(ValidationError);
    expect(() => buildInsightsQuery({ search: 'a'.repeat(300), regex: true }, 10, 200)).toThrow(/too long/);
  });

  it('clamps the limit', () => {
    expect(buildInsightsQuery({}, 999_999)).toContain('| limit 10000');
  });
});

describe('CloudWatchLogsInsightsAdapter', () => {
  it('parses @timestamp/@message, infers level, labels LIVE, one query per service log group', async () => {
    const { client, sent } = fakeClient({
      results: () => ({
        status: 'Complete',
        results: [row('2026-09-28 04:00:00.000', 'DB pool timeout acquiring connection'), row('2026-09-28 03:00:00.000', 'GET /health 200 ok')],
      }),
    });
    const a = new CloudWatchLogsInsightsAdapter(OPTS, 'us-east-1', client);
    const res = await a.getLogs({ services: ['main'], startTime: '2026-09-28T00:00:00Z', endTime: '2026-09-29T00:00:00Z' });
    expect(res.meta.source).toBe('LIVE');
    expect(res.meta.scope).toMatch(/Logs Insights/);
    expect(res.value.map((l) => l.level)).toEqual(['ERROR', 'INFO']);
    expect(res.value[0]).toMatchObject({ service: 'main', environment: 'qa', timestamp: '2026-09-28T04:00:00.000Z' });
    const start = sent.find((c) => c instanceof StartQueryCommand).input;
    expect(start.logGroupNames).toEqual(['/aws/ecs/main/app']);
    expect(start.startTime).toBe(Date.parse('2026-09-28T00:00:00Z') / 1000);
  });

  it('applies the level filter after retrieval and sorts oldest first', async () => {
    const { client } = fakeClient({
      results: () => ({
        status: 'Complete',
        results: [row('2026-09-28 04:00:00.000', 'DB pool timeout'), row('2026-09-28 03:00:00.000', 'GET /health 200 ok'), row('2026-09-28 02:00:00.000', 'fatal crash')],
      }),
    });
    const a = new CloudWatchLogsInsightsAdapter(OPTS, 'us-east-1', client);
    const res = await a.getLogs({ services: ['main'], levels: ['ERROR', 'FATAL'], sort: 'oldest' });
    expect(res.value.map((l) => l.message)).toEqual(['fatal crash', 'DB pool timeout']);
  });

  it('polls until Complete', async () => {
    const { client } = fakeClient({
      results: (_i, n) => (n < 3 ? { status: 'Running' } : { status: 'Complete', results: [row('2026-09-28 04:00:00.000', 'ok')] }),
    });
    const a = new CloudWatchLogsInsightsAdapter(OPTS, 'us-east-1', client);
    const res = await a.getLogs({ services: ['main'] });
    expect(res.meta.source).toBe('LIVE');
    expect(res.value).toHaveLength(1);
  });

  it('times out honestly as WAITING_FOR_INTEGRATION (never LIVE)', async () => {
    const { client } = fakeClient({ results: () => ({ status: 'Running' }) });
    const a = new CloudWatchLogsInsightsAdapter({ ...OPTS, timeoutMs: 30 }, 'us-east-1', client);
    const res = await a.getLogs({ services: ['main'] });
    expect(res.meta.source).toBe('WAITING_FOR_INTEGRATION');
    expect(res.meta.note).toMatch(/timed out/);
    expect(res.value).toEqual([]);
  });

  it('maps access denied to WAITING_FOR_INTEGRATION with an IAM hint', async () => {
    const { client } = fakeClient({ start: () => named('AccessDeniedException') });
    const a = new CloudWatchLogsInsightsAdapter(OPTS, 'us-east-1', client);
    const res = await a.getLogs({ services: ['main'] });
    expect(res.meta.source).toBe('WAITING_FOR_INTEGRATION');
    expect(res.meta.note).toMatch(/access denied/);
    expect(res.meta.note).toMatch(/logs:StartQuery/);
  });

  it('is WAITING_FOR_INTEGRATION without calling AWS when no log group is configured', async () => {
    const { client, sent } = fakeClient({});
    const a = new CloudWatchLogsInsightsAdapter({ ...OPTS, logGroups: {} }, 'us-east-1', client);
    const res = await a.getLogs({});
    expect(res.meta.source).toBe('WAITING_FOR_INTEGRATION');
    expect(res.meta.note).toMatch(/no log group configured/);
    expect(sent).toHaveLength(0);
  });

  it('partial success stays LIVE but names the server that could not be searched', async () => {
    const { client } = fakeClient({
      start: (input) => (input.logGroupNames[0].includes('payments') ? named('AccessDeniedException') : { queryId: 'q' }),
      results: () => ({ status: 'Complete', results: [row('2026-09-28 04:00:00.000', 'hello')] }),
    });
    const a = new CloudWatchLogsInsightsAdapter(OPTS, 'us-east-1', client);
    const res = await a.getLogs({});
    expect(res.meta.source).toBe('LIVE');
    expect(res.meta.note).toMatch(/payments: access denied/);
    expect(res.value).toHaveLength(1);
  });

  it('flags truncation when the result cap is reached (pagination happens over the capped window)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`2026-09-28 04:${String(10 + i)}:00.000`, `line ${i}`));
    const { client } = fakeClient({ results: () => ({ status: 'Complete', results: rows, statistics: { recordsMatched: 500 } }) });
    const a = new CloudWatchLogsInsightsAdapter(OPTS, 'us-east-1', client);
    const res = await a.getLogs({ services: ['main'] });
    expect(res.value).toHaveLength(10);
    expect(res.meta.truncated).toBe(true);
    expect(res.meta.windowCap).toBe(10);
  });

  it('rejects an unsafe regex before any AWS call', async () => {
    const { client, sent } = fakeClient({});
    const a = new CloudWatchLogsInsightsAdapter(OPTS, 'us-east-1', client);
    await expect(a.getLogs({ search: '(a+)+$', regex: true })).rejects.toBeInstanceOf(ValidationError);
    expect(sent).toHaveLength(0);
  });
});
