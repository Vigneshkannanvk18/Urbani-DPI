import { describe, it, expect, afterEach, vi } from 'vitest';
import { HttpUrbaniChatProvider } from './HttpUrbaniChatProvider';
import { ServiceUnavailableError } from '../../lib/errors';
import type { AskLogsInput } from '../ai/AIProvider';

const BASE = 'https://example.test/qa';
const KEY = 'test-chat-key';
const MODEL = 'global.amazon.nova-2-lite-v1:0';

function provider() {
  return new HttpUrbaniChatProvider(BASE, KEY, 'main', MODEL, 30_000);
}

const input: AskLogsInput = {
  question: 'Are there any errors right now?',
  logs: [],
  service: 'main',
  environment: 'qa',
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

  it('maps a LIVE /chat 200 (markdown answer, counts->note, citations [], model_id)', async () => {
    const f = mockFetch({
      service_id: 'main',
      question: input.question,
      answer: '## Findings\n\nThere is **one** error right now.',
      evidence: { log_windows: 3, alerts: 1 },
      model_id: 'global.amazon.nova-2-lite-v1:0',
    });
    vi.stubGlobal('fetch', f);

    const res = await provider().askLogs(input);

    expect(res.answer).toBe('## Findings\n\nThere is **one** error right now.');
    expect(res.citations).toEqual([]);
    expect(res.modelId).toBe('global.amazon.nova-2-lite-v1:0');
    expect(res.provider).toBe('HttpUrbaniChatProvider');
    expect(res.meta.source).toBe('LIVE');
    expect(res.meta.note).toContain('3 recent log window(s)');
    expect(res.meta.note).toContain('1 alert(s)');
  });

  it('falls back to the configured model label when model_id is absent', async () => {
    vi.stubGlobal('fetch', mockFetch({ answer: 'ok', evidence: { log_windows: 0, alerts: 0 } }));
    const res = await provider().askLogs(input);
    expect(res.modelId).toBe(MODEL);
    // Missing evidence counts render 0/0, not an error.
    expect(res.meta.note).toContain('0 recent log window(s)');
  });

  it('sends the x-api-key header + {service,question} body (no minutes) and never leaks the key', async () => {
    const f = mockFetch({ answer: 'ok', evidence: { log_windows: 0, alerts: 0 }, model_id: MODEL });
    vi.stubGlobal('fetch', f);

    const res = await provider().askLogs(input);

    const [url, init] = (f as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe(`${BASE}/chat`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ service: 'main', question: input.question });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('sends the SELECTED service (payments), not the constructor default', async () => {
    const f = mockFetch({ answer: 'ok', evidence: { log_windows: 0, alerts: 0 }, model_id: MODEL });
    vi.stubGlobal('fetch', f);

    await provider().askLogs({ ...input, service: 'payments' });

    const [, init] = (f as unknown as vi.Mock).mock.calls[0];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ service: 'payments', question: input.question });
  });

  it('throws ServiceUnavailableError on a non-2xx (no fabricated answer, no key leak)', async () => {
    vi.stubGlobal('fetch', mockFetch({}, false, 403));
    const p = provider();
    await expect(p.askLogs(input)).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(p.askLogs(input)).rejects.not.toThrowError(new RegExp(KEY));
  });

  it('throws ServiceUnavailableError when fetch rejects (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    );
    await expect(provider().askLogs(input)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('throws ServiceUnavailableError on a 2xx body with no recognizable answer field', async () => {
    vi.stubGlobal('fetch', mockFetch({ service_id: 'main', evidence: { log_windows: 0, alerts: 0 } }));
    await expect(provider().askLogs(input)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('delegates analyzeTelemetry to the Mock provider (no live analyze endpoint)', async () => {
    const res = await provider().analyzeTelemetry({
      logs: [],
      metrics: [],
      service: 'main',
      environment: 'qa',
    });
    expect(res.provider).toBe('MockAIProvider');
    expect(res.meta.source).toBe('MOCK');
    expect(res.alert).toBeNull();
  });
});
