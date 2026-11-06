import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UrbaniIncidentAlert } from '@urbani/shared';
import { PersistenceError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { dynamoHarness, makeTestClock } from '../../test/repositoryHarness';
import type { Repositories } from '../types';
import { EVIDENCE_BUDGET_BYTES } from './items';
import { ENTITY_TYPES } from './keys';

/**
 * DynamoDB-only behaviour on DynamoDB Local (design §8.3): the evidence budget, the item size guard and
 * `entityType` on every item that any create path writes. Skipped unless DYNAMODB_ENDPOINT is set.
 */

const endpoint = process.env.DYNAMODB_ENDPOINT;
const T0 = '2026-10-05T00:00:00.000Z';

function makeAlert(alertId: string, over: Partial<UrbaniIncidentAlert> = {}): UrbaniIncidentAlert {
  return {
    alertId,
    timestamp: T0,
    service: 'main',
    environment: 'qa',
    severity: 'HIGH',
    anomalyType: 'DatabaseConnectionTimeout',
    summary: 'DB connection pool exhausted',
    evidence: ['evidence line 1'],
    probableCause: 'Unclosed sessions',
    recommendedActions: ['Check pool size'],
    confidence: 0.8,
    modelId: 'model-test',
    ...over,
  };
}

describe.skipIf(!endpoint)('DynamoDB-only behaviour (set DYNAMODB_ENDPOINT to run)', { timeout: 20_000 }, () => {
  const harness = dynamoHarness(endpoint!);
  let repos: Repositories;

  beforeAll(() => harness.setupSuite(), 60_000);
  beforeEach(async () => {
    repos = await harness.fresh(makeTestClock());
  });
  afterEach(() => harness.cleanup());
  afterAll(() => harness.teardownSuite(), 60_000);

  it('stores an oversized-evidence alert trimmed and logs a warn', async () => {
    // 300 lines of about 1 KB: over the 256 KiB evidence budget, under the item limit once trimmed.
    const evidence = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(1000)}`);
    const warn = vi.spyOn(logger, 'warn');
    try {
      await repos.alerts.insert(makeAlert('ALT-BIG', { evidence }));
      const kept = (await repos.alerts.findById('ALT-BIG'))?.evidence ?? [];
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(evidence.length);
      expect(kept).toEqual(evidence.slice(0, kept.length));
      expect(Buffer.byteLength(kept.join(''), 'utf8')).toBeLessThanOrEqual(EVIDENCE_BUDGET_BYTES);
      expect(warn).toHaveBeenCalledWith('Alert evidence trimmed to fit DynamoDB item limit', {
        alertId: 'ALT-BIG',
        keptLines: kept.length,
        droppedLines: evidence.length - kept.length,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('raises ITEM_TOO_LARGE for an over-limit non-alert item and writes nothing', async () => {
    const err = await repos.integrations
      .upsert({
        id: 'int-big',
        kind: 'CLOUDWATCH',
        display_name: 'Oversized integration',
        mode: 'MOCK',
        status: 'WAITING_FOR_INTEGRATION',
        config_json: JSON.stringify({ blob: 'x'.repeat(400 * 1024) }),
        updated_at: T0,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PersistenceError);
    expect((err as PersistenceError).reason).toBe('ITEM_TOO_LARGE');
    expect(await harness.scanAll()).toEqual([]);
  });

  it('every create path writes entityType on every item, covering all 16 values', async () => {
    await repos.users.upsertRole({ id: 'role-admin', name: 'ADMIN', description: null, permissions: '["*"]', created_at: T0 });
    await repos.users.upsertUser({
      id: 'user-1',
      email: 'user1@example.test',
      display_name: 'User 1',
      password_hash: 'hash-not-a-secret',
      role_id: 'role-admin',
      is_active: 1,
      last_login_at: null,
      created_at: T0,
    });
    await repos.preferences.update('user-1', { theme: 'dark' });
    await repos.audit.record('user1@example.test', 'LOGIN');
    await repos.alerts.insert(makeAlert('ALT-MOCK'));
    await repos.alerts.upsertLivePreservingStatus(makeAlert('ALT-LIVE', { timestamp: '2026-10-05T00:00:01.000Z' }));
    await repos.services.upsert(
      { id: 'svc-main', name: 'main', environment: 'qa', status: 'HEALTHY', errorRate: 0.01, lastTelemetryAt: T0, lastIncidentAt: null },
      'MOCK',
    );
    await repos.environments.ensure({ id: 'env-qa', name: 'qa' });
    await repos.logs.upsertMany(
      [{ id: 'log-1', timestamp: T0, level: 'ERROR', service: 'main', environment: 'qa', message: 'boom' }],
      'MOCK',
    );
    await repos.metrics.upsertMany(
      [
        {
          id: 'metric-1',
          service: 'main',
          environment: 'qa',
          timestamp: T0,
          cpuPercent: 41.5,
          memoryPercent: 63.25,
          errorRate: 0.02,
          requestCount: 1200,
          latencyMsP95: 310,
          http5xxCount: 3,
          instanceRestarts: 0,
        },
      ],
      'MOCK',
    );
    await repos.usage.upsertMany(
      [
        {
          id: 'usage-1',
          date: '2026-10-05',
          modelId: 'model-test',
          aiRequestCount: 1,
          inputTokens: 10,
          outputTokens: 20,
          estimatedCostUsd: 0.01,
        },
      ],
      'MOCK',
    );
    await repos.aiAnalyses.insert({
      alertId: 'ALT-MOCK',
      timestamp: T0,
      service: 'main',
      environment: 'qa',
      modelId: 'model-test',
      provider: 'MockAIProvider',
      anomalyType: 'DatabaseConnectionTimeout',
      confidence: 0.5,
      finding: null,
      inputTokens: 10,
      outputTokens: 20,
      dataSource: 'MOCK',
    });
    await repos.integrations.upsert({
      id: 'int-cloudwatch',
      kind: 'CLOUDWATCH',
      display_name: 'CloudWatch',
      mode: 'MOCK',
      status: 'WAITING_FOR_INTEGRATION',
      config_json: '{}',
      updated_at: T0,
    });
    const session = await repos.chat.createSession({ userId: 'user-1', title: 'Chat' });
    const message = await repos.chat.appendMessage({ sessionId: session.id, role: 'user', content: 'hello' });
    await repos.chat.setFeedback({ sessionId: session.id, messageId: message.id, userId: 'user-1', rating: 'LIKE' });

    const items = await harness.scanAll();
    for (const item of items) expect(ENTITY_TYPES).toContain(item.entityType);
    expect(new Set(items.map((i) => i.entityType))).toEqual(new Set(ENTITY_TYPES));
    expect(items.find((i) => i.PK === 'ALERT' && i.SK === 'ALT-LIVE')?.entityType).toBe('ALERT');
    expect(items.find((i) => i.PK === 'PREFS' && i.SK === 'user-1')?.userId).toBe('user-1');
  });
});
