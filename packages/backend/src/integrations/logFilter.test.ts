import { describe, it, expect, afterEach, vi } from 'vitest';
import { MockCloudWatchAdapter } from './mock/MockCloudWatchAdapter';
import { HttpUrbaniLogsAdapter } from './live/HttpUrbaniLogsAdapter';
import { mockLogs } from './mock/mockData';
import { ValidationError } from '../lib/errors';

describe('MockCloudWatchAdapter filters', () => {
  const a = new MockCloudWatchAdapter();

  it('filters by multiple levels and legacy level', async () => {
    const multi = await a.getLogs({ levels: ['ERROR', 'WARN'] });
    expect(multi.value.length).toBeGreaterThan(0);
    expect(multi.value.every((l) => ['ERROR', 'WARN'].includes(l.level))).toBe(true);
    const legacy = await a.getLogs({ level: 'ERROR' });
    expect(legacy.value.every((l) => l.level === 'ERROR')).toBe(true);
  });

  it('filters by multiple services', async () => {
    const res = await a.getLogs({ services: ['payments'] });
    expect(res.value.length).toBeGreaterThan(0);
    expect(res.value.every((l) => l.service === 'payments')).toBe(true);
  });

  it('filters by inclusive date range', async () => {
    const sorted = [...mockLogs].sort((x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp));
    const from = sorted[10].timestamp;
    const to = sorted[19].timestamp;
    const res = await a.getLogs({ startTime: from, endTime: to });
    expect(res.value).toHaveLength(10);
    for (const l of res.value) {
      expect(Date.parse(l.timestamp)).toBeGreaterThanOrEqual(Date.parse(from));
      expect(Date.parse(l.timestamp)).toBeLessThanOrEqual(Date.parse(to));
    }
  });

  it('text search is a case-insensitive substring', async () => {
    const needle = mockLogs[0].message.slice(2, 12).toUpperCase();
    const res = await a.getLogs({ search: needle });
    expect(res.value.length).toBeGreaterThan(0);
    expect(res.value.every((l) => l.message.toUpperCase().includes(needle))).toBe(true);
  });

  it('regex search treats the term as a pattern, text search does not', async () => {
    const asRegex = await a.getLogs({ search: 'timeout|exhausted', regex: true });
    const asText = await a.getLogs({ search: 'timeout|exhausted' });
    expect(asRegex.value.length).toBeGreaterThan(0);
    expect(asText.value).toHaveLength(0);
  });

  it('rejects a ReDoS regex with a 400 ValidationError', async () => {
    await expect(a.getLogs({ search: '(a+)+$', regex: true })).rejects.toBeInstanceOf(ValidationError);
  });

  it('sorts newest/oldest and reports window metadata', async () => {
    const newest = await a.getLogs({ sort: 'newest' });
    const oldest = await a.getLogs({ sort: 'oldest' });
    expect(Date.parse(newest.value[0].timestamp)).toBeGreaterThan(Date.parse(oldest.value[0].timestamp));
    expect(newest.meta.source).toBe('MOCK');
    expect(newest.meta.windowCap).toBe(100);
    expect(newest.meta.scope).toBeTruthy();
  });
});

describe('HttpUrbaniLogsAdapter filters (mocked fetch)', () => {
  afterEach(() => vi.restoreAllMocks());

  function stub() {
    const latest = {
      service_id: 'main',
      window_end: '2026-09-28T04:05:00Z',
      logs: [
        { timestamp: '2026-09-28T04:00:00Z', message: 'DB pool timeout acquiring connection' },
        { timestamp: '2026-09-28T03:00:00Z', message: 'high latency WARNING on /orders' },
        { timestamp: '2026-09-28T02:00:00Z', message: 'GET /health 200 ok' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.includes('/logs/history') ? { windows: [] } : latest),
      })) as unknown as typeof fetch,
    );
    return new HttpUrbaniLogsAdapter('https://example.test/qa', 'k', 'main', 5, 20, ['main'], 'qa');
  }

  it('filters by levels, date range, text and regex', async () => {
    const a = stub();
    expect((await a.getLogs({ levels: ['ERROR', 'WARN'] })).value).toHaveLength(2);
    expect((await a.getLogs({ startTime: '2026-09-28T02:30:00Z', endTime: '2026-09-28T03:30:00Z' })).value).toHaveLength(1);
    expect((await a.getLogs({ search: 'LATENCY' })).value).toHaveLength(1);
    const rx = await a.getLogs({ search: '^GET /\\w+ 200', regex: true });
    expect(rx.value).toHaveLength(1);
    expect(rx.value[0].message).toContain('/health');
  });

  it('sorts oldest first and states the (bounded) scope honestly', async () => {
    const a = stub();
    const res = await a.getLogs({ sort: 'oldest' });
    expect(res.value[0].message).toContain('/health');
    expect(res.meta.source).toBe('LIVE');
    expect(res.meta.scope).toMatch(/Not the full CloudWatch stream/);
    expect(res.meta.truncated).toBe(false);
  });

  it('rejects a ReDoS regex with a 400 ValidationError', async () => {
    await expect(stub().getLogs({ search: '(a|aa)+$', regex: true })).rejects.toBeInstanceOf(ValidationError);
  });
});
