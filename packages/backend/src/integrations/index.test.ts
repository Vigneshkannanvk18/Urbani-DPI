import { describe, it, expect, afterEach, vi } from 'vitest';
import { getIntegrations, resetIntegrations } from './index';

describe('integration factory', () => {
  afterEach(() => resetIntegrations());

  it('wires LIVE adapters in live mode (fresh-config dynamic import)', async () => {
    const snapshot = { ...process.env };
    try {
      // config is built ONCE at import from a process.env snapshot, so flip env
      // and re-import a fresh module graph. Dummy creds (dotenv won't override
      // already-set keys) — no network call occurs at construction.
      process.env.INTEGRATION_MODE = 'live';
      process.env.URBANI_API_BASE_URL = 'https://example.test/qa';
      process.env.URBANI_API_KEY = 'dummy-test-key';
      vi.resetModules();
      const mod = await import('./index');
      const live = mod.getIntegrations();
      expect(live.aiProvider.name).toBe('HttpUrbaniChatProvider');
      expect(live.cloudwatch.kind).toBe('CLOUDWATCH');
      expect(live.urbaniAlerts).toBeDefined();
    } finally {
      process.env = snapshot;
      vi.resetModules();
    }
  });

  it('wires MOCK adapters in mock mode (default in tests)', () => {
    const i = getIntegrations();
    expect(i.cloudwatch.kind).toBe('CLOUDWATCH');
    expect(i.bedrock.kind).toBe('BEDROCK');
    expect(i.dynamodb.kind).toBe('DYNAMODB');
    expect(i.urbaniApp.kind).toBe('URBANI_APP');
    expect(i.aiProvider.name).toBe('MockAIProvider');
  });

  it('CloudWatch mock honours the 100-line cap', async () => {
    const { cloudwatch } = getIntegrations();
    const res = await cloudwatch.getLogs({ limit: 1000 });
    expect(res.meta.source).toBe('MOCK');
    expect(res.value.length).toBeLessThanOrEqual(100);
  });

  it('Bedrock mock flags guardrail intervention on PII-like input', async () => {
    const { bedrock } = getIntegrations();
    const res = await bedrock.invokeModel({
      modelId: 'test',
      prompt: 'here is a password=hunter2 in the logs',
      temperature: 0,
      maxTokens: 100,
      topP: 1,
    });
    expect(res.value.guardrailIntervened).toBe(true);
  });
});
