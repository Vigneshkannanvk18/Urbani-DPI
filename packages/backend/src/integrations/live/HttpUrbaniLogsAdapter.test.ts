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

  it('degrades to [] (never throws) on a non-200 and still labels LIVE', async () => {
    vi.stubGlobal('fetch', routedFetch({ ok: false, status: 403 }));
    const a = adapter();
    const res = await a.getLogs({});
    expect(res.meta.source).toBe('LIVE');
    expect(res.value).toEqual([]);
    // The key is never leaked in the degraded result.
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('serves metrics as MOCK (metrics endpoint not available on QA)', async () => {
    const res = await adapter().getMetrics({});
    expect(res.meta.source).toBe('MOCK');
  });
});
