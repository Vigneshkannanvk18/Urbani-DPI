import { describe, it, expect, afterEach, vi } from 'vitest';
import { HttpUrbaniChatProvider } from './HttpUrbaniChatProvider';
import type { AskLogsInput } from '../ai/AIProvider';

const BASE = 'https://example.test/prod';
const KEY = 'test-chat-key';
const MODEL = 'apac.amazon.nova-lite-v1:0';

function provider() {
  return new HttpUrbaniChatProvider(BASE, KEY, 'urbani-app', MODEL, 20_000);
}

const input: AskLogsInput = {
  question: 'Are there any errors right now?',
  logs: [],
  service: 'urbani-app',
  environment: 'production-eb',
};

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('HttpUrbaniChatProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps the empty-window response faithfully (no fabrication)', async () => {
    const f = mockFetch({
      service_id: 'urbani-app',
      window_start: '2026-10-05T10:40:00+00:00',
      window_end: '2026-10-05T10:45:00+00:00',
      log_count: 0,
      answer: 'No log evidence was found in the current log window.',
      evidence: [],
      confidence: 1.0,
      advisory: true,
      modelId: null,
    });
    vi.stubGlobal('fetch', f);

    const res = await provider().askLogs(input);

    expect(res.answer).toBe('No log evidence was found in the current log window.');
    expect(res.citations).toEqual([]);
    // null modelId falls back to the configured Nova Lite label.
    expect(res.modelId).toBe(MODEL);
    expect(res.provider).toBe('HttpUrbaniChatProvider');
    expect(res.meta.source).toBe('LIVE');
  });

  it('maps an evidence response (log_count NUMBER) into citations', async () => {
    const evidence = ['2026-10-05 10:47 ERROR DatabaseConnectionTimeout connection pool exhausted'];
    const f = mockFetch({
      service_id: 'urbani-app',
      log_count: 1,
      answer: 'Yes, there is an error right now.',
      evidence,
      confidence: 0.95,
      advisory: true,
      modelId: 'apac.amazon.nova-lite-v1:0',
    });
    vi.stubGlobal('fetch', f);

    const res = await provider().askLogs(input);

    expect(res.answer).toBe('Yes, there is an error right now.');
    expect(res.citations).toEqual(evidence);
    expect(res.modelId).toBe('apac.amazon.nova-lite-v1:0');
    expect(res.meta.source).toBe('LIVE');
  });

  it('sends the x-api-key header + question body and never leaks the key', async () => {
    const f = mockFetch({ answer: 'ok', evidence: [], modelId: null, log_count: 0 });
    vi.stubGlobal('fetch', f);

    const res = await provider().askLogs(input);

    const [url, init] = (f as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe(`${BASE}/chat`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ service: 'urbani-app', question: input.question });
    // The key never appears in the mapped result.
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('sends the configured minutes window so chat matches the Logs page', async () => {
    const f = mockFetch({ answer: 'ok', evidence: [], modelId: null, log_count: 0 });
    vi.stubGlobal('fetch', f);

    const windowed = new HttpUrbaniChatProvider(BASE, KEY, 'urbani-app', MODEL, 20_000, 1440);
    await windowed.askLogs(input);

    const [, init] = (f as unknown as vi.Mock).mock.calls[0];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ service: 'urbani-app', question: input.question, minutes: 1440 });
  });

  it('unwraps nested-JSON evidence into clean "LEVEL: message" citations', async () => {
    const nested = JSON.stringify({
      timestamp: '2026-10-06T06:48:12+00:00',
      level: 'ERROR',
      service: 'urbani-app',
      message: 'DatabaseConnectionTimeout connection pool exhausted',
      error_code: 'DB_CONNECTION_TIMEOUT',
    });
    vi.stubGlobal('fetch', mockFetch({
      service_id: 'urbani-app',
      log_count: 1,
      answer: 'Yes, there are errors right now.',
      evidence: [nested],
      confidence: 1.0,
      advisory: true,
      modelId: 'apac.amazon.nova-lite-v1:0',
    }));

    const res = await new HttpUrbaniChatProvider(BASE, KEY, 'urbani-app', MODEL, 20_000, 1440).askLogs(input);
    expect(res.citations).toEqual(['ERROR: DatabaseConnectionTimeout connection pool exhausted']);
  });

  it('cleans a JSON FRAGMENT evidence string (no leading brace) into a citation', async () => {
    // Observed live: some evidence arrives as a bare fragment, not a full object.
    const fragment =
      '"message":"DatabaseConnectionTimeout connection pool exhausted","component":"database","error_code":"DB_CONNECTION_TIMEOUT"';
    vi.stubGlobal('fetch', mockFetch({
      service_id: 'urbani-app',
      log_count: 1,
      answer: 'Here is how to fix it.',
      evidence: [fragment],
      confidence: 1.0,
      advisory: true,
      modelId: 'apac.amazon.nova-lite-v1:0',
    }));

    const res = await new HttpUrbaniChatProvider(BASE, KEY, 'urbani-app', MODEL, 20_000, 1440).askLogs(input);
    // Clean message extracted, no raw JSON fragment leaked.
    expect(res.citations).toEqual(['DatabaseConnectionTimeout connection pool exhausted']);
    expect(res.citations[0]).not.toContain('"error_code"');
  });

  it('falls back to the Mock provider on a non-200 (no throw, no key leak)', async () => {
    vi.stubGlobal('fetch', mockFetch({}, false, 403));

    const res = await provider().askLogs(input);

    // Graceful fallback: answer still produced, labelled MOCK.
    expect(res.provider).toBe('MockAIProvider');
    expect(res.meta.source).toBe('MOCK');
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('falls back to the Mock provider when fetch rejects (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    );

    const res = await provider().askLogs(input);

    expect(res.provider).toBe('MockAIProvider');
    expect(res.meta.source).toBe('MOCK');
  });

  it('delegates analyzeTelemetry to the Mock provider (no live analyze endpoint)', async () => {
    const res = await provider().analyzeTelemetry({
      logs: [],
      metrics: [],
      service: 'urbani-app',
      environment: 'production-eb',
    });
    expect(res.provider).toBe('MockAIProvider');
    expect(res.meta.source).toBe('MOCK');
    // No error evidence -> no fabricated alert.
    expect(res.alert).toBeNull();
  });
});
