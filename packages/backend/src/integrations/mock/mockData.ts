import type {
  LogEntry,
  MetricSnapshot,
  ServiceSummary,
  UrbaniIncidentAlert,
  UsageRecord,
} from '@urbani/shared';

/**
 * Controlled MOCK / seed dataset (Phase 1).
 *
 * EVERYTHING here is fabricated demo data. It is ALWAYS surfaced with a MOCK
 * data-source label — it must never be presented as real AWS telemetry. It is
 * modelled on the documented demo scenario (DB connection exhaustion on
 * urbani-core-api) so the dashboard tells a coherent story.
 */

export const MOCK_NOTE = 'Seeded demo data (Phase 1). Not real AWS telemetry — awaiting integration.';

const now = Date.parse('2026-09-23T08:00:00.000Z');
const iso = (offsetMinutes: number): string => new Date(now + offsetMinutes * 60_000).toISOString();

export const mockServices: ServiceSummary[] = [
  {
    id: 'svc-core-api',
    name: 'urbani-core-api',
    environment: 'production-eb',
    status: 'DEGRADED',
    lastTelemetryAt: iso(-2),
    alertCount: 3,
    errorRate: 4.2,
    lastIncidentAt: iso(-12),
  },
  {
    id: 'svc-worker',
    name: 'urbani-worker',
    environment: 'production-eb',
    status: 'HEALTHY',
    lastTelemetryAt: iso(-1),
    alertCount: 0,
    errorRate: 0.1,
    lastIncidentAt: null,
  },
  {
    id: 'svc-web',
    name: 'urbani-web',
    environment: 'staging-eb',
    status: 'HEALTHY',
    lastTelemetryAt: iso(-3),
    alertCount: 1,
    errorRate: 0.8,
    lastIncidentAt: iso(-1440),
  },
];

export const mockAlerts: UrbaniIncidentAlert[] = [
  {
    alertId: 'ALT-20260923-001',
    timestamp: iso(-12),
    service: 'urbani-core-api',
    environment: 'production-eb',
    severity: 'CRITICAL',
    anomalyType: 'DatabaseConnectionTimeout',
    summary: 'High frequency of DB connection timeout exceptions in the last log window.',
    evidence: [
      '2026-09-23 07:48:11 ERROR ConnectionPool: Timeout acquiring connection from pool (waited 30000ms)',
      '2026-09-23 07:48:14 ERROR ConnectionPool: Timeout acquiring connection from pool (waited 30000ms)',
      '2026-09-23 07:48:19 WARN  HikariPool-1: Connection is not available, request timed out after 30001ms',
    ],
    probableCause: 'Connection pool exhaustion, likely from unclosed DB sessions under load.',
    recommendedActions: [
      'Check active DB connection metrics in RDS and compare against pool max size.',
      'Review recent deploys for unclosed connections or missing try/finally cleanup.',
      'Consider temporarily increasing the connection pool size while investigating.',
    ],
    confidence: 0.92,
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  },
  {
    alertId: 'ALT-20260923-002',
    timestamp: iso(-45),
    service: 'urbani-core-api',
    environment: 'production-eb',
    severity: 'HIGH',
    anomalyType: 'ElevatedErrorRate',
    summary: 'HTTP 5xx error rate exceeded the baseline for the /orders endpoint.',
    evidence: [
      '2026-09-23 07:15:02 ERROR OrdersController: Unhandled exception serializing response',
      '2026-09-23 07:15:40 ERROR OrdersController: NullReferenceException in order mapping',
    ],
    probableCause: 'A recent change introduced a null field in the order serialization path.',
    recommendedActions: [
      'Inspect the /orders serialization code path for null handling.',
      'Correlate the error spike with the most recent deployment timestamp.',
    ],
    confidence: 0.81,
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  },
  {
    alertId: 'ALT-20260923-003',
    timestamp: iso(-180),
    service: 'urbani-web',
    environment: 'staging-eb',
    severity: 'MEDIUM',
    anomalyType: 'MemoryPressure',
    summary: 'Sustained memory usage above 85% on the staging web tier.',
    evidence: ['2026-09-23 05:00:00 WARN  MemoryMonitor: heap usage 87% sustained for 10m'],
    probableCause: 'Possible memory leak or under-provisioned instance for staging load tests.',
    recommendedActions: [
      'Capture a heap snapshot on the staging instance.',
      'Compare memory trend against the last known-good build.',
    ],
    confidence: 0.68,
    modelId: 'amazon.nova-lite-v1:0',
  },
];

const LOG_MESSAGES: Array<Pick<LogEntry, 'level' | 'message'>> = [
  { level: 'ERROR', message: 'ConnectionPool: Timeout acquiring connection from pool (waited 30000ms)' },
  { level: 'WARN', message: 'HikariPool-1: Connection is not available, request timed out' },
  { level: 'INFO', message: 'GET /orders 200 128ms' },
  { level: 'INFO', message: 'GET /health 200 3ms' },
  { level: 'ERROR', message: 'OrdersController: NullReferenceException in order mapping' },
  { level: 'DEBUG', message: 'Cache hit for key services:list' },
  { level: 'WARN', message: 'Latency above p95 threshold for /orders' },
];

export const mockLogs: LogEntry[] = Array.from({ length: 60 }, (_, i) => {
  const tpl = LOG_MESSAGES[i % LOG_MESSAGES.length];
  const svc = mockServices[i % mockServices.length];
  return {
    id: `log-${String(i + 1).padStart(4, '0')}`,
    timestamp: iso(-i * 2),
    level: tpl.level,
    service: svc.name,
    environment: svc.environment,
    message: tpl.message,
  };
});

export const mockMetrics: MetricSnapshot[] = mockServices.flatMap((svc) =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `metric-${svc.id}-${i}`,
    service: svc.name,
    environment: svc.environment,
    timestamp: iso(-i * 5),
    cpuPercent: 30 + ((i * 7 + svc.name.length) % 55),
    memoryPercent: 40 + ((i * 5 + svc.name.length) % 50),
    errorRate: svc.errorRate + ((i % 3) * 0.5),
    requestCount: 800 + ((i * 37) % 400),
    latencyMsP95: 120 + ((i * 13) % 260),
    http5xxCount: svc.status === 'HEALTHY' ? i % 2 : (i % 4) + 1,
    instanceRestarts: i === 0 && svc.status === 'DEGRADED' ? 1 : 0,
  })),
);

export const mockUsage: UsageRecord[] = Array.from({ length: 7 }, (_, i) => {
  const requests = 288; // documented 5-min cadence => 288 runs/day
  const inputTokens = requests * 1500;
  const outputTokens = requests * 300;
  return {
    id: `usage-${i}`,
    date: new Date(now - i * 86_400_000).toISOString().slice(0, 10),
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    aiRequestCount: requests,
    inputTokens,
    outputTokens,
    // Illustrative estimate only; real billing arrives via AWS integration in P2.
    estimatedCostUsd: Number(((inputTokens / 1000) * 0.003 + (outputTokens / 1000) * 0.015).toFixed(2)),
  };
});
