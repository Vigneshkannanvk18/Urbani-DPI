import { describe, it, expect } from 'vitest';
import type { LogEntry, MetricSnapshot } from '@urbani/shared';
import { MockAIProvider } from './MockAIProvider';

const MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

function log(level: LogEntry['level'], message: string): LogEntry {
  return {
    id: `l-${Math.random()}`,
    timestamp: '2026-09-23T08:00:00.000Z',
    level,
    service: 'urbani-core-api',
    environment: 'production-eb',
    message,
  };
}

const noMetrics: MetricSnapshot[] = [];

describe('MockAIProvider', () => {
  const provider = new MockAIProvider(MODEL);

  it('returns NO anomaly (null alert) when there is no error evidence (grounding rule)', async () => {
    const res = await provider.analyzeTelemetry({
      logs: [log('INFO', 'GET /health 200'), log('DEBUG', 'cache hit')],
      metrics: noMetrics,
      service: 'urbani-core-api',
      environment: 'production-eb',
    });
    expect(res.alert).toBeNull();
    expect(res.provider).toBe('MockAIProvider');
  });

  it('produces an evidence-based finding that only cites provided log lines', async () => {
    const errorMsg = 'ConnectionPool: Timeout acquiring connection from pool';
    const res = await provider.analyzeTelemetry({
      logs: [log('ERROR', errorMsg), log('ERROR', errorMsg), log('ERROR', errorMsg)],
      metrics: noMetrics,
      service: 'urbani-core-api',
      environment: 'production-eb',
    });
    expect(res.alert).not.toBeNull();
    expect(res.alert!.anomalyType).toBe('DatabaseConnectionTimeout');
    // CRITICAL because production + DB timeout.
    expect(res.alert!.severity).toBe('CRITICAL');
    // Every evidence line must trace back to an input log message.
    for (const line of res.alert!.evidence) {
      expect(line).toContain(errorMsg);
    }
    // Advisory only: no evidence line implies an automated production command.
    for (const action of res.alert!.recommendedActions) {
      expect(action.toLowerCase()).not.toContain('automatically');
    }
  });

  it('uses the configured model id (never hardcoded in logic)', async () => {
    const custom = new MockAIProvider('amazon.nova-lite-v1:0');
    const res = await custom.analyzeTelemetry({
      logs: [log('ERROR', 'unhandled NullReferenceException')],
      metrics: noMetrics,
      service: 'urbani-web',
      environment: 'staging-eb',
    });
    expect(res.modelId).toBe('amazon.nova-lite-v1:0');
    expect(res.alert?.modelId).toBe('amazon.nova-lite-v1:0');
  });

  it('is deterministic for the same input', async () => {
    const input = {
      logs: [log('ERROR', 'ConnectionPool: Timeout acquiring connection')],
      metrics: noMetrics,
      service: 'urbani-core-api',
      environment: 'production-eb',
    };
    const a = await provider.analyzeTelemetry(input);
    const b = await provider.analyzeTelemetry(input);
    expect(a.alert?.severity).toBe(b.alert?.severity);
    expect(a.alert?.anomalyType).toBe(b.alert?.anomalyType);
    expect(a.alert?.confidence).toBe(b.alert?.confidence);
  });
});
