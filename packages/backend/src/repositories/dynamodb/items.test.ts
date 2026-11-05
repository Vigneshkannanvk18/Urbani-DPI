import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry, MetricSnapshot, UrbaniIncidentAlert } from '@urbani/shared';
import { PersistenceError, type PersistenceReason } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { RoleRow, UserRow } from '../types';
import {
  alertItem,
  analysisItem,
  auditItem,
  budgetEvidence,
  chatMessageItem,
  chatSessionItem,
  emailLockItem,
  environmentItem,
  EVIDENCE_BUDGET_BYTES,
  feedbackItem,
  integrationItem,
  ITEM_SIZE_LIMIT_BYTES,
  itemToAlert,
  logItem,
  metricItem,
  preferencesItem,
  roleItem,
  serviceItem,
  usageItem,
  userItem,
  type DynamoItem,
} from './items';
import { ENTITY_TYPES } from './keys';

const NOW = '2026-10-05T00:00:00.000Z';
const KIB = 1024;

function makeAlert(over: Partial<UrbaniIncidentAlert> = {}): UrbaniIncidentAlert {
  return {
    alertId: 'ALT-1',
    timestamp: NOW,
    service: 'main',
    environment: 'qa',
    severity: 'HIGH',
    anomalyType: 'DatabaseConnectionTimeout',
    summary: 'DB connection pool exhausted',
    evidence: ['evidence line 1', 'evidence line 2'],
    probableCause: 'Unclosed sessions',
    recommendedActions: ['Check pool size'],
    confidence: 0.8,
    modelId: 'model-test',
    ...over,
  };
}

const log: LogEntry = { id: 'log-1', timestamp: NOW, level: 'ERROR', service: 'main', environment: 'qa', message: 'boom' };
const metric: MetricSnapshot = {
  id: 'met-1',
  service: 'main',
  environment: 'qa',
  timestamp: NOW,
  cpuPercent: 41.5,
  memoryPercent: 63.25,
  errorRate: 0.02,
  requestCount: 1200,
  latencyMsP95: 310,
  http5xxCount: 3,
  instanceRestarts: 0,
};
const role: RoleRow = { id: 'role-admin', name: 'ADMIN', description: null, permissions: '["*"]', created_at: NOW };
const user: UserRow = {
  id: 'u1',
  email: 'u1@urbani.test',
  display_name: 'User 1',
  password_hash: 'hash-not-a-secret',
  role_id: 'role-admin',
  is_active: 1,
  last_login_at: null,
  created_at: NOW,
  role: 'SUPER_ADMIN',
};
const audit = {
  id: 'ev-1',
  timestamp: NOW,
  actor: 'alice@urbani.test',
  action: 'LOGIN' as const,
  target: null,
  metadataJson: null,
  result: 'SUCCESS' as const,
  createdAt: NOW,
};
const session = {
  id: 'sess-1',
  userId: 'u1',
  title: null,
  service: null,
  environment: null,
  messageCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
};
const message = {
  id: 'msg-1',
  sessionId: 'sess-1',
  role: 'assistant' as const,
  content: 'answer',
  citations: ['line'],
  provider: null,
  modelId: null,
  source: null,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  createdAt: NOW,
};

function reasonOf(build: () => unknown): PersistenceReason | null {
  try {
    build();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(PersistenceError);
    return (err as PersistenceError).reason;
  }
}

describe('dynamodb items', () => {
  afterEach(() => vi.restoreAllMocks());

  it('an alert item round-trips through itemToAlert', () => {
    for (const a of [makeAlert(), makeAlert({ alertId: 'ALT-2', confidence: null, evidence: [], recommendedActions: [] })]) {
      const item = alertItem(a, 'MOCK', 'OPEN', NOW);
      expect(item).toMatchObject({
        PK: 'ALERT',
        SK: a.alertId,
        GSI1PK: 'ALERTSRC#MOCK',
        GSI1SK: a.alertId,
        entityType: 'ALERT',
        status: 'OPEN',
        acknowledgedBy: null,
        acknowledgedAt: null,
        dataSource: 'MOCK',
        createdAt: NOW,
        confidence: a.confidence,
      });
      expect(itemToAlert(item, { logIds: ['l1'], metricIds: [] })).toEqual({
        ...a,
        status: 'OPEN',
        acknowledgedBy: null,
        acknowledgedAt: null,
        relatedLogIds: ['l1'],
        relatedMetricIds: [],
      });
    }
    const acked = alertItem(makeAlert(), 'LIVE', 'ACKNOWLEDGED', NOW, { acknowledgedBy: 'ops@urbani.test', acknowledgedAt: NOW });
    expect(acked.GSI1PK).toBe('ALERTSRC#LIVE');
    expect(itemToAlert(acked, { logIds: [], metricIds: [] })).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedBy: 'ops@urbani.test',
      acknowledgedAt: NOW,
    });
  });

  it('budgetEvidence drops the first line over 256 KiB and every later line, keeping text intact', () => {
    const warn = vi.spyOn(logger, 'warn');
    const a = 'a'.repeat(100 * KIB);
    const b = 'b'.repeat(100 * KIB);
    const c = 'c'.repeat(60 * KIB);
    expect(budgetEvidence([a, b, c, 'd'], 'ALT-9')).toEqual([a, b]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Alert evidence trimmed to fit DynamoDB item limit', {
      alertId: 'ALT-9',
      keptLines: 2,
      droppedLines: 2,
    });

    // Bytes, not characters: 'é' is 2 UTF-8 bytes, so this line uses the whole budget.
    const full = 'é'.repeat(EVIDENCE_BUDGET_BYTES / 2);
    expect(budgetEvidence([full], 'ALT-9')).toEqual([full]);
    expect(budgetEvidence([full, 'x'], 'ALT-9')).toEqual([full]);
    expect(budgetEvidence(['short', 'lines'], 'ALT-9')).toEqual(['short', 'lines']);
    expect(warn).toHaveBeenCalledTimes(2);

    // The alert builder applies the budget.
    expect(alertItem(makeAlert({ evidence: [a, b, c] }), 'LIVE', 'OPEN', NOW).evidence).toEqual([a, b]);
  });

  it('a log item always has GSI1SK and has GSI1PK only when linked; metrics likewise', () => {
    const unlinked = logItem(log, 'MOCK');
    expect(unlinked).toMatchObject({ PK: 'LOG', SK: 'log-1', GSI1SK: `LOG#${NOW}#log-1`, entityType: 'LOG', dataSource: 'MOCK' });
    expect('GSI1PK' in unlinked).toBe(false);
    expect('alertId' in unlinked).toBe(false);
    expect(logItem(log, 'MOCK', 'ALT-1')).toMatchObject({
      GSI1PK: 'ALERTLINK#ALT-1',
      GSI1SK: `LOG#${NOW}#log-1`,
      alertId: 'ALT-1',
    });

    const m = metricItem(metric, 'MOCK');
    expect(m).toMatchObject({ PK: 'METRIC', SK: 'met-1', GSI1SK: `METRIC#${NOW}#met-1` });
    expect('GSI1PK' in m).toBe(false);
    expect(metricItem(metric, 'MOCK', 'ALT-1').GSI1PK).toBe('ALERTLINK#ALT-1');

    const analysis = {
      id: 'an-1',
      alertId: null,
      timestamp: NOW,
      service: 'main',
      environment: 'qa',
      modelId: 'model-test',
      provider: 'MockAIProvider',
      anomalyType: null,
      confidence: null,
      finding: null,
      inputTokens: 1,
      outputTokens: 2,
      dataSource: 'MOCK' as const,
    };
    const a = analysisItem(analysis, NOW);
    expect(a).toMatchObject({ PK: 'AI_ANALYSIS', SK: 'an-1', GSI1SK: `AI#${NOW}#an-1`, findingJson: 'null' });
    expect('GSI1PK' in a).toBe(false);
    expect(analysisItem({ ...analysis, alertId: 'ALT-1' }, NOW)).toMatchObject({ GSI1PK: 'ALERTLINK#ALT-1', alertId: 'ALT-1' });
  });

  it('audit and chat key formats', () => {
    expect(auditItem(audit)).toMatchObject({
      PK: 'AUDIT',
      SK: `${NOW}#ev-1`,
      GSI1PK: 'ACTOR#alice@urbani.test',
      GSI1SK: `${NOW}#ev-1`,
      metadata: null,
      result: 'SUCCESS',
    });
    expect(chatSessionItem(session)).toMatchObject({
      PK: 'CHAT#sess-1',
      SK: 'SESSION',
      GSI1PK: 'CHATUSER#u1',
      GSI1SK: `${NOW}#sess-1`,
    });
    const msg = chatMessageItem(message);
    expect(msg).toMatchObject({ PK: 'CHAT#sess-1', SK: 'MSG#msg-1', citations: ['line'] });
    expect('GSI1PK' in msg).toBe(false);
    expect(
      feedbackItem({
        messageId: 'msg-1',
        sessionId: 'sess-1',
        userId: 'u1',
        rating: 'LIKE',
        comment: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ PK: 'CHAT#sess-1', SK: 'FEEDBACK#msg-1' });
  });

  it('the usage SK is the natural key <date>#<modelId>', () => {
    const u = usageItem(
      { id: 'use-1', date: '2026-10-02', modelId: 'model-test', aiRequestCount: 5, inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.1 },
      'MOCK',
    );
    expect(u).toMatchObject({ PK: 'USAGE', SK: '2026-10-02#model-test', id: 'use-1', entityType: 'USAGE' });
  });

  it('the size guard throws ITEM_TOO_LARGE before any write', () => {
    expect(reasonOf(() => logItem({ ...log, message: 'x'.repeat(ITEM_SIZE_LIMIT_BYTES) }, 'MOCK'))).toBe('ITEM_TOO_LARGE');
    expect(
      reasonOf(() => auditItem({ ...audit, metadataJson: JSON.stringify({ blob: 'y'.repeat(ITEM_SIZE_LIMIT_BYTES) }) })),
    ).toBe('ITEM_TOO_LARGE');
    expect(reasonOf(() => logItem({ ...log, message: 'x'.repeat(300 * KIB) }, 'MOCK'))).toBeNull();
  });

  it('every builder sets its §5.2 entityType, and the 16 values are exactly ENTITY_TYPES', () => {
    const builders: Array<[string, () => DynamoItem]> = [
      ['ROLE', () => roleItem(role)],
      ['USER', () => userItem(user)],
      ['USER_EMAIL', () => emailLockItem(user.email, user.id)],
      ['PREFS', () => preferencesItem({ userId: 'u1', theme: 'dark', widgetLayoutJson: null, updatedAt: NOW })],
      ['AUDIT', () => auditItem(audit)],
      ['ALERT', () => alertItem(makeAlert(), 'MOCK', 'OPEN', NOW)],
      [
        'SERVICE',
        () =>
          serviceItem(
            { id: 'svc-main', name: 'main', environment: 'qa', status: 'HEALTHY', errorRate: 0.01, lastTelemetryAt: NOW, lastIncidentAt: null },
            'MOCK',
            NOW,
          ),
      ],
      ['ENVIRONMENT', () => environmentItem({ id: 'env-qa', name: 'qa' }, NOW)],
      ['LOG', () => logItem(log, 'MOCK')],
      ['METRIC', () => metricItem(metric, 'MOCK')],
      [
        'AI_ANALYSIS',
        () =>
          analysisItem(
            {
              id: 'an-1',
              alertId: null,
              timestamp: NOW,
              service: 'main',
              environment: 'qa',
              modelId: 'm',
              provider: 'p',
              anomalyType: null,
              confidence: null,
              finding: null,
              inputTokens: 0,
              outputTokens: 0,
              dataSource: 'MOCK',
            },
            NOW,
          ),
      ],
      [
        'USAGE',
        () =>
          usageItem(
            { id: 'use-1', date: '2026-10-02', modelId: 'm', aiRequestCount: 1, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
            'MOCK',
          ),
      ],
      [
        'INTEGRATION',
        () =>
          integrationItem({
            id: 'int-a',
            kind: 'BEDROCK',
            display_name: 'Bedrock',
            mode: 'MOCK',
            status: 'WAITING_FOR_INTEGRATION',
            config_json: '{}',
            updated_at: NOW,
          }),
      ],
      ['CHAT_SESSION', () => chatSessionItem(session)],
      ['CHAT_MESSAGE', () => chatMessageItem(message)],
      [
        'CHAT_FEEDBACK',
        () =>
          feedbackItem({ messageId: 'msg-1', sessionId: 'sess-1', userId: 'u1', rating: 'LIKE', comment: null, createdAt: NOW, updatedAt: NOW }),
      ],
    ];
    const produced = builders.map(([expected, build]) => {
      const item = build();
      expect(item.entityType).toBe(expected);
      return item.entityType as string;
    });
    expect(produced).toHaveLength(16);
    expect(new Set(produced).size).toBe(16);
    expect([...produced].sort()).toEqual([...ENTITY_TYPES].sort());
  });

  it('emailLockItem is exactly the lock item', () => {
    expect(emailLockItem('a@x.test', 'u1')).toEqual({ PK: 'USER_EMAIL', SK: 'a@x.test', entityType: 'USER_EMAIL', userId: 'u1' });
  });

  it('[F34] a builder given an empty id or an oversized key throws INVALID_ARGUMENT', () => {
    expect(reasonOf(() => alertItem(makeAlert({ alertId: '' }), 'MOCK', 'OPEN', NOW))).toBe('INVALID_ARGUMENT');
    expect(reasonOf(() => logItem({ ...log, id: '' }, 'MOCK'))).toBe('INVALID_ARGUMENT');
    expect(reasonOf(() => userItem({ ...user, id: '' }))).toBe('INVALID_ARGUMENT');
    expect(reasonOf(() => emailLockItem('', 'u1'))).toBe('INVALID_ARGUMENT');
    expect(reasonOf(() => roleItem({ ...role, id: '' }))).toBe('INVALID_ARGUMENT');

    // Sort keys hold at most 1,024 UTF-8 bytes ('é' is 2 bytes), partition keys 2,048.
    expect(reasonOf(() => roleItem({ ...role, id: 'é'.repeat(512) }))).toBeNull();
    expect(reasonOf(() => roleItem({ ...role, id: 'é'.repeat(513) }))).toBe('INVALID_ARGUMENT');
    expect(reasonOf(() => alertItem(makeAlert({ alertId: 'k'.repeat(1025) }), 'MOCK', 'OPEN', NOW))).toBe('INVALID_ARGUMENT');
    expect(reasonOf(() => auditItem({ ...audit, actor: 'a'.repeat(2042) }))).toBeNull(); // GSI1PK = 2,048 bytes
    expect(reasonOf(() => auditItem({ ...audit, actor: 'a'.repeat(2043) }))).toBe('INVALID_ARGUMENT');
  });
});
