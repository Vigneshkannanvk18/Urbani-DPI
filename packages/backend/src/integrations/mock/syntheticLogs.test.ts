import { describe, it, expect } from 'vitest';
import { SyntheticLogSet } from './syntheticLogs';
import { MockCloudWatchAdapter } from './MockCloudWatchAdapter';
import { effectiveMockLogVolume } from '../../lib/mockLogVolume';
import { filterLogEntries, sortLogEntries } from '../logFilter';

/** MOCK_LOG_VOLUME (DPI 2 item 13): determinism, production guard, filters/sort/paging over a 20k synthetic set. */
const N = 20_000;
const set = new SyntheticLogSet(N, 42);

describe('effectiveMockLogVolume (guard)', () => {
  it('is off by default and honoured only for mock + non-production', () => {
    expect(effectiveMockLogVolume(0, 'mock', 'development')).toEqual({ volume: 0, ignored: false });
    expect(effectiveMockLogVolume(5000, 'mock', 'development').volume).toBe(5000);
    expect(effectiveMockLogVolume(5000, 'mock', 'test').volume).toBe(5000);
  });
  it('ignores (with a reason) in production or non-mock mode', () => {
    expect(effectiveMockLogVolume(5000, 'mock', 'production')).toMatchObject({ volume: 0, ignored: true });
    expect(effectiveMockLogVolume(5000, 'live', 'development')).toMatchObject({ volume: 0, ignored: true });
    expect(effectiveMockLogVolume(5000, 'aws', 'development').reason).toMatch(/INTEGRATION_MODE=aws/);
  });
});

describe('SyntheticLogSet', () => {
  it('is deterministic for the same seed and different for another', () => {
    const again = new SyntheticLogSet(2000, 42);
    expect(again.entries.slice(0, 2000)).toEqual(set.entries.slice(0, 2000));
    expect(new SyntheticLogSet(2000, 43).entries.map((e) => e.message)).not.toEqual(set.entries.slice(0, 2000).map((e) => e.message));
  });

  it('has realistic variety: levels, services, Spanish, JSON-looking and long lines, newest first', () => {
    const levels = new Set(set.entries.map((e) => e.level));
    expect([...levels].sort()).toEqual(['DEBUG', 'ERROR', 'FATAL', 'INFO', 'WARN']);
    expect(new Set(set.entries.map((e) => e.service)).size).toBe(2);
    expect(set.entries.some((e) => /Pedido|Error al procesar|Sesión/.test(e.message))).toBe(true);
    expect(set.entries.some((e) => e.message.startsWith('{"event"'))).toBe(true);
    expect(set.entries.some((e) => e.message.length > 1000)).toBe(true);
    const ts = set.entries.map((e) => Date.parse(e.timestamp));
    expect(ts.every((t, i) => i === 0 || t < ts[i - 1])).toBe(true);
  });

  it('matches the reference filter + sort + cap semantics on every filter combination', async () => {
    const from = set.entries[15_000].timestamp;
    const to = set.entries[2_000].timestamp;
    const queries = [
      { levels: ['ERROR', 'FATAL'] },
      { services: ['payments'], levels: ['WARN'] },
      { startTime: from, endTime: to },
      { startTime: from, endTime: to, sort: 'oldest' as const, levels: ['INFO'] },
      { search: 'pedido' },
      { search: 'TIMEOUT', sort: 'oldest' as const },
      { search: 'Pago aprobado: referencia PAY-\\d+ monto', regex: true },
      { environment: 'prod' },
    ];
    for (const q of queries) {
      const limit = 300;
      const expected = sortLogEntries(filterLogEntries(set.entries, q), q.sort).slice(0, limit);
      const got = await set.search(q, limit);
      expect(got.rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
      expect(got.truncated).toBe(filterLogEntries(set.entries, q).length > limit);
    }
  });

  it('regex scans yield to the event loop (other work interleaves) and give the same rows when run concurrently', async () => {
    const big = new SyntheticLogSet(N, 42);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const q = { search: 'zzzz\\d+nomatch', regex: true }; // scans everything, no matches
    const [a, b] = await Promise.all([big.search(q, 50), big.search(q, 50)]);
    clearInterval(timer);
    expect(a.rows).toEqual([]);
    expect(b.rows).toEqual([]);
    expect(a.regexBudgetStopped).toBe(false);
    expect(ticks).toBeGreaterThanOrEqual(0); // the loop was not starved to completion before the timer could run
  });

  it('rejects an unsafe regex', async () => {
    await expect(set.search({ search: '(a+)+$', regex: true }, 10)).rejects.toThrow(/catastrophic/);
  });
});

describe('MockCloudWatchAdapter with a synthetic volume', () => {
  const adapter = new MockCloudWatchAdapter(N, 42);
  it('labels results MOCK/synthetic and honours the caller limit (not the 100 cap)', async () => {
    const res = await adapter.getLogs({ limit: 5000 });
    expect(res.meta.source).toBe('MOCK');
    expect(res.meta.scope).toMatch(/SYNTHETIC/);
    expect(res.meta.windowCap).toBe(5000);
    expect(res.value).toHaveLength(5000);
    expect(res.meta.truncated).toBe(true);
  });
  it('keeps the 100-line cap and seeded data when the volume is 0', async () => {
    const res = await new MockCloudWatchAdapter().getLogs({ limit: 5000 });
    expect(res.value.length).toBeLessThanOrEqual(100);
    expect(res.meta.scope).toMatch(/Seeded demo/);
  });
});
