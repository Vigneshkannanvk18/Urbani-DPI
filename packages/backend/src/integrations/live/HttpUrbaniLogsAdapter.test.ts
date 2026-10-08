import { describe, it, expect, afterEach, vi } from 'vitest';
import { HttpUrbaniLogsAdapter } from './HttpUrbaniLogsAdapter';

const BASE = 'https://example.test/qa';
const KEY = 'test-key';

/**
 * Mock the QA endpoints. The adapter fetches BOTH /logs/latest and
 * /logs/history per service; route by URL so each gets its own body.
 */
function routedFetch(byPath: {
  latest?: unknown;
  history?: unknown;
  ok?: boolean;
  status?: number;
}) {
  const ok = byPath.ok ?? true;
  const status = byPath.status ?? 200;
  return vi.fn(async (url: string) => ({
    ok,
    status,
    json: async () =>
      url.includes('/logs/history') ? (byPath.history ?? {}) : (byPath.latest ?? {}),
  })) as unknown as typeof fetch;
}

function adapter() {
  // Single enabled service 'main' keeps assertions simple unless a test overrides.
  return new HttpUrbaniLogsAdapter(BASE, KEY, 'main', 5, 20, ['main'], 'qa');
}

describe('HttpUrbaniLogsAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('labels results LIVE and sends the x-api-key header', async () => {
    const f = routedFetch({ latest: { service_id: 'main', logs: [], log_count: 0 }, history: { windows: [] } });
    vi.stubGlobal('fetch', f);

    const res = await adapter().getLogs({ limit: 100 });

    expect(res.meta.source).toBe('LIVE');
    expect(res.value).toEqual([]);
    const [, init] = (f as unknown as vi.Mock).mock.calls[0];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('maps QA latest+history {timestamp,message} and INFERS level from the text', async () => {
    const f = routedFetch({
      latest: {
        service_id: 'main',
        window_end: '2026-09-28T04:05:00Z',
        logs: [{ timestamp: '2026-09-28T04:00:00Z', message: 'DB pool timeout acquiring connection' }],
      },
      history: {
        service_id: 'main',
        windows: [
          {
            window_end: '2026-09-28T03:05:00Z',
            logs: [
              { timestamp: '2026-09-28T03:00:00Z', message: 'high latency WARNING on /orders' },
              { timestamp: '2026-09-28T02:00:00Z', message: 'GET /health 200 ok' },
            ],
          },
        ],
      },
    });
    vi.stubGlobal('fetch', f);

    const { value } = await adapter().getLogs({});

    expect(value).toHaveLength(3);
    // Newest-first ordering (latest window first).
    expect(value[0]).toMatchObject({ message: 'DB pool timeout acquiring connection', service: 'main' });
    expect(value[0].level).toBe('ERROR'); // "timeout" -> ERROR
    expect(value[1].level).toBe('WARN'); // "WARNING" -> WARN
    expect(value[2].level).toBe('INFO'); // default
    for (const e of value) {
      expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
      expect(e.id).toBeTruthy();
      expect(e.environment).toBe('qa');
    }
  });

  it('unwraps a message that is a stringified JSON event (uses the embedded level)', async () => {
    const inner = JSON.stringify({
      timestamp: '2026-10-06T06:48:12.033704+00:00',
      level: 'ERROR',
      service: 'main',
      message: 'DatabaseConnectionTimeout connection pool exhausted',
      error_code: 'DB_CONNECTION_TIMEOUT',
    });
    const f = routedFetch({
      latest: {
        service_id: 'main',
        window_end: '2026-10-06T06:50:00Z',
        logs: [{ timestamp: '2026-10-06 06:48:21.475', message: inner }],
      },
      history: { windows: [] },
    });
    vi.stubGlobal('fetch', f);

    const { value } = await adapter().getLogs({});
    expect(value).toHaveLength(1);
    expect(value[0].level).toBe('ERROR');
    expect(value[0].message).toBe('DatabaseConnectionTimeout connection pool exhausted');
  });

  it('de-duplicates entries present in both latest and history', async () => {
    const dup = { timestamp: '2026-09-28T04:00:00Z', message: 'DB pool timeout' };
    const f = routedFetch({
      latest: { service_id: 'main', window_end: '2026-09-28T04:05:00Z', logs: [dup] },
      history: { windows: [{ window_end: '2026-09-28T04:05:00Z', logs: [dup] }] },
    });
    vi.stubGlobal('fetch', f);
    const { value } = await adapter().getLogs({});
    expect(value).toHaveLength(1);
  });

  it('sorts newest-first and places an unparseable timestamp LAST (not first)', async () => {
    const f = routedFetch({
      latest: {
        service_id: 'main',
        // No response-level window_end, so the bad-ts row cannot borrow one.
        logs: [
          { timestamp: 'not-a-date', message: 'unparseable line' },
          { timestamp: '2026-09-28T04:00:00Z', message: 'DB pool timeout' },
          { timestamp: '2026-09-28T03:00:00Z', message: 'earlier line' },
        ],
      },
      history: { windows: [] },
    });
    vi.stubGlobal('fetch', f);

    const { value } = await adapter().getLogs({});
    expect(value).toHaveLength(3);
    // Real newest first; unparseable sorts last.
    expect(value[0].message).toBe('DB pool timeout');
    expect(value[2].message).toBe('unparseable line');
  });

  it('applies level filtering over the merged window', async () => {
    const f = routedFetch({
      latest: {
        service_id: 'main',
        window_end: '2026-09-28T04:05:00Z',
        logs: [
          { timestamp: '2026-09-28T04:00:00Z', message: 'boom ERROR failure' },
          { timestamp: '2026-09-28T04:00:01Z', message: 'all ok here' },
        ],
      },
      history: { windows: [] },
    });
    vi.stubGlobal('fetch', f);
    const { value } = await adapter().getLogs({ level: 'ERROR' });
    expect(value).toHaveLength(1);
    expect(value[0].message).toBe('boom ERROR failure');
  });

  it('degrades to WAITING_FOR_INTEGRATION (never throws) when all fetches fail with no lines', async () => {
    vi.stubGlobal('fetch', routedFetch({ ok: false, status: 403 }));
    const a = adapter();
    const res = await a.getLogs({});
    // A fully-failed, empty fetch is degraded, distinguishable from empty-success.
    expect(res.meta.source).toBe('WAITING_FOR_INTEGRATION');
    expect(res.value).toEqual([]);
    // The key is never leaked in the degraded result.
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('a successful-but-empty window stays LIVE (not degraded)', async () => {
    const f = routedFetch({ latest: { service_id: 'main', logs: [] }, history: { windows: [] } });
    vi.stubGlobal('fetch', f);
    const res = await adapter().getLogs({});
    expect(res.meta.source).toBe('LIVE');
    expect(res.value).toEqual([]);
  });

  it('a partial success (one service returns lines, another fails) stays LIVE', async () => {
    // Two enabled services; main returns a line, payments 500s. Route by both
    // path AND service so the two services get different outcomes.
    const f = vi.fn(async (url: string) => {
      const isPayments = url.includes('service=payments');
      if (isPayments) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes('/logs/history')
            ? { windows: [] }
            : {
                service_id: 'main',
                logs: [{ timestamp: '2026-09-28T04:00:00Z', message: 'main log line' }],
              },
      };
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', f);
    const a = new HttpUrbaniLogsAdapter(BASE, KEY, 'main', 5, 20, ['main', 'payments'], 'qa');
    const res = await a.getLogs({});
    expect(res.meta.source).toBe('LIVE');
    expect(res.value).toHaveLength(1);
  });

  it('serves metrics as MOCK (metrics endpoint not available on QA)', async () => {
    const res = await adapter().getMetrics({});
    expect(res.meta.source).toBe('MOCK');
  });

  it('surfaces alert-evidence lines as LogEntry rows when /logs/* is empty', async () => {
    // /logs/* exposes an empty window (relevant_log_count=0), exactly like QA.
    const f = routedFetch({ latest: { service_id: 'main', logs: [], log_count: 10 }, history: { windows: [] } });
    vi.stubGlobal('fetch', f);

    const a = adapter();
    a.setAlertEvidenceSource({
      getLatest: async () => [makeAlert('main', [
        JSON.stringify({
          timestamp: '2026-10-08T09:26:10.209Z',
          level: 'error',
          message: '[wallet:getPendingReward] X-Internal-Auth-Urbani no está configurado',
        }),
        'Error user balances  ApiError: No se pudo completar la operación en Wallet',
      ])],
      getHistory: async () => [],
    });

    const res = await a.getLogs({ service: 'main', limit: 100 });

    expect(res.meta.source).toBe('LIVE');
    expect(res.meta.note).toContain('incident evidence');
    expect(res.value).toHaveLength(2);

    const [first, second] = res.value;
    // JSON-stringified evidence: real timestamp + embedded level + verbatim message.
    expect(first.message).toBe('[wallet:getPendingReward] X-Internal-Auth-Urbani no está configurado');
    expect(first.level).toBe('ERROR');
    expect(first.timestamp).toBe('2026-10-08T09:26:10.209Z');
    expect(first.service).toBe('main');
    expect(first.environment).toBe('qa');
    expect(first.id).toBeTruthy();
    // Plain-string evidence: level inferred from text ("Error"/"No se pudo") and
    // timestamp falls back to the alert's own timestamp.
    expect(second.message).toBe('Error user balances  ApiError: No se pudo completar la operación en Wallet');
    expect(second.level).toBe('ERROR');
    expect(second.timestamp).toBe('2026-10-08T09:00:00.000Z');
  });

  it('alert-evidence lines are filterable by level/search and scoped to the service', async () => {
    const f = routedFetch({ latest: { service_id: 'main', logs: [] }, history: { windows: [] } });
    vi.stubGlobal('fetch', f);
    const a = new HttpUrbaniLogsAdapter(BASE, KEY, 'main', 5, 20, ['main', 'payments'], 'qa');
    a.setAlertEvidenceSource({
      getLatest: async () => [
        makeAlert('main', ['boom ERROR in main']),
        makeAlert('payments', ['payments 403 forbidden']),
      ],
      getHistory: async () => [],
    });

    // Service filter keeps only the main alert's evidence.
    const onlyMain = await a.getLogs({ service: 'main', limit: 100 });
    expect(onlyMain.value.map((e) => e.service)).toEqual(['main']);

    // Search filter applies across the merged (evidence) window.
    const searched = await a.getLogs({ search: '403', limit: 100 });
    expect(searched.value).toHaveLength(1);
    expect(searched.value[0].message).toContain('403');
  });

  it('yields NO fabricated lines when alerts have empty/absent evidence', async () => {
    const f = routedFetch({ latest: { service_id: 'main', logs: [] }, history: { windows: [] } });
    vi.stubGlobal('fetch', f);
    const a = adapter();
    a.setAlertEvidenceSource({
      getLatest: async () => [makeAlert('main', [])],
      getHistory: async () => [],
    });
    const res = await a.getLogs({ service: 'main', limit: 100 });
    expect(res.meta.source).toBe('LIVE');
    expect(res.value).toEqual([]);
    // No evidence lines were produced, so the note stays the plain live-logs note.
    expect(res.meta.note).not.toContain('incident evidence');
  });
});

/** Minimal UrbaniIncidentAlert fixture for alert-evidence backfill tests. */
function makeAlert(service: string, evidence: string[]) {
  return {
    alertId: `ALT-${service}`,
    timestamp: '2026-10-08T09:00:00.000Z',
    service,
    environment: 'qa',
    severity: 'MEDIUM' as const,
    anomalyType: 'Test',
    summary: 'test',
    evidence,
    probableCause: '',
    recommendedActions: [],
    confidence: 0.7,
    modelId: 'test-model',
  };
}
