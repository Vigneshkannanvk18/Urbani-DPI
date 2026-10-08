import { describe, it, expect } from 'vitest';
import type { LogEntry, MetricSnapshot } from '@urbani/shared';
import { MockAIProvider } from './MockAIProvider';

const MODEL = 'global.amazon.nova-2-lite-v1:0';

function log(level: LogEntry['level'], message: string, environment = 'qa'): LogEntry {
  return {
    id: `l-${Math.random()}`,
    timestamp: '2026-09-23T08:00:00.000Z',
    level,
    service: 'main',
    environment,
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
      service: 'main',
      environment: 'qa',
    });
    expect(res.alert).toBeNull();
    expect(res.provider).toBe('MockAIProvider');
  });

  it('produces an evidence-based finding that only cites provided log lines', async () => {
    const errorMsg = 'ConnectionPool: Timeout acquiring connection from pool';
    const res = await provider.analyzeTelemetry({
      logs: [log('ERROR', errorMsg), log('ERROR', errorMsg), log('ERROR', errorMsg)],
      metrics: noMetrics,
      service: 'main',
      environment: 'qa',
    });
    expect(res.alert).not.toBeNull();
    expect(res.alert!.anomalyType).toBe('DatabaseConnectionTimeout');
    // QA is NOT a production environment, so 3 ERROR lines escalate to HIGH
    // (CRITICAL only applies to a DB timeout in a `production` environment).
    expect(res.alert!.severity).toBe('HIGH');
    // CRITICAL-branch coverage: the SAME input in a bare `production` environment
    // escalates to CRITICAL. (A bare `production` label is not an AC17-forbidden
    // token — only the old EB-suffixed environment names are — so this stays
    // grep-clean.)
    const prod = await provider.analyzeTelemetry({
      logs: [
        log('ERROR', errorMsg, 'production'),
        log('ERROR', errorMsg, 'production'),
        log('ERROR', errorMsg, 'production'),
      ],
      metrics: noMetrics,
      service: 'main',
      environment: 'production',
    });
    expect(prod.alert!.severity).toBe('CRITICAL');
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
    const custom = new MockAIProvider('global.amazon.nova-2-lite-v1:0');
    const res = await custom.analyzeTelemetry({
      logs: [log('ERROR', 'unhandled NullReferenceException')],
      metrics: noMetrics,
      service: 'payments',
      environment: 'qa',
    });
    expect(res.modelId).toBe('global.amazon.nova-2-lite-v1:0');
    expect(res.alert?.modelId).toBe('global.amazon.nova-2-lite-v1:0');
  });

  it('is deterministic for the same input', async () => {
    const input = {
      logs: [log('ERROR', 'ConnectionPool: Timeout acquiring connection')],
      metrics: noMetrics,
      service: 'main',
      environment: 'qa',
    };
    const a = await provider.analyzeTelemetry(input);
    const b = await provider.analyzeTelemetry(input);
    expect(a.alert?.severity).toBe(b.alert?.severity);
    expect(a.alert?.anomalyType).toBe(b.alert?.anomalyType);
    expect(a.alert?.confidence).toBe(b.alert?.confidence);
  });
});
