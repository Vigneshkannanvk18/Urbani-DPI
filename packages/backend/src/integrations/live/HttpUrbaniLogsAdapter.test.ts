import { describe, it, expect, afterEach, vi } from 'vitest';
import { HttpUrbaniLogsAdapter } from './HttpUrbaniLogsAdapter';

const BASE = 'https://example.test/prod';
const KEY = 'test-key';

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('HttpUrbaniLogsAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('labels results LIVE and sends the x-api-key header', async () => {
    const f = mockFetch({ service_id: 'urbani-app', logs: [], log_count: '0' });
    vi.stubGlobal('fetch', f);

    const adapter = new HttpUrbaniLogsAdapter(BASE, KEY, 'urbani-app', 5);
    const res = await adapter.getLogs({ limit: 100 });

    expect(res.meta.source).toBe('LIVE');
    expect(res.value).toEqual([]);
    // Header carries the key; the key is never returned in meta/value.
    const [, init] = (f as unknown as vi.Mock).mock.calls[0];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('maps varied upstream log shapes into the LogEntry contract', async () => {
    const f = mockFetch({
      service_id: 'urbani-app',
      logs: [
        { timestamp: '2026-09-28T04:00:00Z', level: 'ERROR', message: 'DB pool timeout' },
        { '@timestamp': '2026-09-28T04:01:00Z', severity: 'warning', '@message': 'high latency' },
        'plain string line',
      ],
    });
    vi.stubGlobal('fetch', f);

    const adapter = new HttpUrbaniLogsAdapter(BASE, KEY, 'urbani-app', 5);
    const { value } = await adapter.getLogs({});

    expect(value).toHaveLength(3);
    expect(value[0]).toMatchObject({ level: 'ERROR', message: 'DB pool timeout', service: 'urbani-app' });
    expect(value[1].level).toBe('WARN'); // "warning" normalized
    expect(value[1].message).toBe('high latency');
    expect(value[2].message).toBe('plain string line');
    expect(value[2].level).toBe('INFO'); // default
    // Every entry has a valid ISO timestamp + id.
    for (const e of value) {
      expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
      expect(e.id).toBeTruthy();
    }
  });

  it('applies level filtering over the fetched window', async () => {
    vi.stubGlobal('fetch', mockFetch({
      service_id: 'urbani-app',
      logs: [
        { timestamp: '2026-09-28T04:00:00Z', level: 'ERROR', message: 'boom' },
        { timestamp: '2026-09-28T04:00:01Z', level: 'INFO', message: 'ok' },
      ],
    }));
    const adapter = new HttpUrbaniLogsAdapter(BASE, KEY, 'urbani-app', 5);
    const { value } = await adapter.getLogs({ level: 'ERROR' });
    expect(value).toHaveLength(1);
    expect(value[0].message).toBe('boom');
  });

  it('surfaces an IntegrationError on non-200 without leaking the key', async () => {
    vi.stubGlobal('fetch', mockFetch({}, false, 403));
    const adapter = new HttpUrbaniLogsAdapter(BASE, KEY, 'urbani-app', 5);
    await expect(adapter.getLogs({})).rejects.toThrowError(/HTTP 403/);
    await expect(adapter.getLogs({})).rejects.not.toThrowError(new RegExp(KEY));
  });

  it('serves metrics as MOCK (metrics endpoint not available)', async () => {
    const adapter = new HttpUrbaniLogsAdapter(BASE, KEY, 'urbani-app', 5);
    const res = await adapter.getMetrics({});
    expect(res.meta.source).toBe('MOCK');
  });
});
