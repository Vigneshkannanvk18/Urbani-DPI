import { describe, it, expect, afterEach, vi } from 'vitest';
import { HttpUrbaniAlertsAdapter } from './HttpUrbaniAlertsAdapter';

const BASE = 'https://example.test/qa';
const KEY = 'test-alerts-key';

/** The real QA alert shape: FLAT, top-level, snake_case. */
const flatAlert = {
  service_id: 'main',
  timestamp: '2026-10-05T10:47:54.190651+00:00',
  alert_id: 'ALT-789A3CCEB56F',
  anomaly_type: 'DatabaseConnectionTimeout',
  severity: 'MEDIUM',
  summary: 'Database connection pool exhausted',
  probable_cause: 'Unclosed DB sessions under load',
  recommendation: 'Check pool size and review recent deploys',
};

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function adapter() {
  return new HttpUrbaniAlertsAdapter(BASE, KEY, 'main', 5, ['main'], 'qa');
}

describe('HttpUrbaniAlertsAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps the flat latest alert (recommendation->single array, derived confidence, no evidence)', async () => {
    const f = mockFetch(flatAlert);
    vi.stubGlobal('fetch', f);

    const res = await adapter().getLatest();

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      alertId: 'ALT-789A3CCEB56F',
      severity: 'MEDIUM',
      anomalyType: 'DatabaseConnectionTimeout',
      service: 'main',
      environment: 'qa',
      probableCause: 'Unclosed DB sessions under load',
    });
    // recommendation (string) -> single-element recommendedActions array.
    expect(res[0].recommendedActions).toEqual(['Check pool size and review recent deploys']);
    // This fixture carries no evidence array — mapped to [], never fabricated.
    expect(res[0].evidence).toEqual([]);
    // QA returns no model confidence; we populate a DERIVED heuristic from
    // severity (MEDIUM -> 0.7). "LIVE alert + non-null confidence" ⇒ derived.
    expect(res[0].confidence).toBe(0.7);
    expect(res[0].modelId).toBe('global.amazon.nova-2-lite-v1:0');
    expect(Number.isNaN(Date.parse(res[0].timestamp))).toBe(false);

    const [url, init] = (f as unknown as vi.Mock).mock.calls[0];
    expect(url).toContain('/alerts/latest?service=main');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('maps upstream evidence: JSON-stringified entries -> .message, plain strings verbatim', async () => {
    const evidence = [
      JSON.stringify({
        timestamp: '2026-10-08T09:26:10.209Z',
        level: 'error',
        message: '[wallet:getPendingReward] X-Internal-Auth-Urbani no está configurado',
      }),
      'Error user balances  ApiError: No se pudo completar la operación en Wallet',
      '', // empty string is skipped
      123, // non-string is skipped
    ];
    vi.stubGlobal('fetch', mockFetch({ ...flatAlert, evidence }));

    const res = await adapter().getLatest();

    expect(res[0].evidence).toEqual([
      '[wallet:getPendingReward] X-Internal-Auth-Urbani no está configurado',
      'Error user balances  ApiError: No se pudo completar la operación en Wallet',
    ]);
  });

  it('maps an absent/empty evidence array to [] (never fabricated)', async () => {
    vi.stubGlobal('fetch', mockFetch({ ...flatAlert, evidence: [] }));
    const res = await adapter().getLatest();
    expect(res[0].evidence).toEqual([]);
  });

  it('returns [] when /alerts/latest has no alert_id (no current alert)', async () => {
    vi.stubGlobal('fetch', mockFetch({ service_id: 'main' }));
    expect(await adapter().getLatest()).toEqual([]);
  });

  it('maps the history list (body.alerts[]) and requests the limit', async () => {
    const f = mockFetch({
      service_id: 'main',
      count: 2,
      alerts: [flatAlert, { ...flatAlert, alert_id: 'ALT-SECOND', severity: 'HIGH' }],
    });
    vi.stubGlobal('fetch', f);

    const res = await adapter().getHistory(5);

    expect(res).toHaveLength(2);
    expect(res.map((a) => a.alertId)).toEqual(['ALT-789A3CCEB56F', 'ALT-SECOND']);
    expect(res[1].severity).toBe('HIGH');
    // Derived confidence tracks the severity table: MEDIUM -> 0.7, HIGH -> 0.8.
    expect(res[0].confidence).toBe(0.7);
    expect(res[1].confidence).toBe(0.8);
    const [url] = (f as unknown as vi.Mock).mock.calls[0];
    expect(url).toContain('/alerts/history?service=main&limit=5');
  });

  it('defaults an unknown severity to MEDIUM and an empty recommendation to []', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...flatAlert, severity: 'weird', recommendation: '   ' }),
    );
    const res = await adapter().getLatest();
    expect(res[0].severity).toBe('MEDIUM');
    expect(res[0].recommendedActions).toEqual([]);
  });

  it('returns [] on a non-200 without throwing or leaking the key', async () => {
    vi.stubGlobal('fetch', mockFetch({}, false, 403));
    const a = adapter();
    await expect(a.getLatest()).resolves.toEqual([]);
    await expect(a.getHistory(5)).resolves.toEqual([]);
  });

  it('a brand-new adapter with no cache yields [] on failure', async () => {
    vi.stubGlobal('fetch', mockFetch({}, false, 500));
    const b = adapter();
    expect(await b.getLatest()).toEqual([]);
  });
});
