import {
  SEVERITIES,
  type HealthHistoryResponse,
  type HealthRange,
  type HealthSeriesPoint,
  type HealthStatus,
  type HealthStatusResponse,
  type HealthTargetStatus,
  type Severity,
} from '@urbani/shared';
import { config } from '../config';
import { NotFoundError } from '../lib/errors';
import { logger } from '../lib/logger';
import { HealthRunner, startHealthScheduler } from '../health/runner';
import { loadTargets, URBANI_API_CONFIG_HINT, WAITING_NOTE, type HealthTarget, type TargetsLoad } from '../health/targets';
import { RANGE_MS, computeUptime, downsample } from '../health/uptime';
import { getRepositories } from '../repositories';
import type { HealthCheckResult } from '../repositories/types';

/** Service health / uptime (DPI 2 item 9). See docs/HEALTH.md for the semantics. */
export const loadConfiguredTargets = (): TargetsLoad =>
  loadTargets(config.health.targetsRaw, {
    urbaniApiConfigured: config.urbani.logsConfigured,
    urbaniServices: config.urbani.services,
  });

let runner: HealthRunner | null = null;
export function getHealthRunner(): HealthRunner {
  runner ??= new HealthRunner({
    repos: getRepositories,
    load: loadConfiguredTargets,
    policy: () => ({ allowPrivate: config.health.allowPrivateTargets, maxResponseBytes: config.health.maxResponseBytes }),
    urbani: () => ({ baseUrl: config.urbani.apiBaseUrl, apiKey: config.urbani.apiKey, service: config.urbani.service }),
  });
  return runner;
}
/** Test hook. */
export function setHealthRunnerForTesting(r: HealthRunner | null): void {
  runner = r;
}

const SERIES_POINTS = 48;
const HISTORY_POINTS = 240;
const staleAfterMs = (): number => Math.max(3 * config.health.intervalSeconds * 1000, 180_000);

function emptyWindow() {
  return { uptimePct: null, samples: 0, insufficientData: true };
}

async function openAlerts(service: string | null): Promise<Record<Severity, number> | null> {
  if (!service || !config.urbani.services.includes(service)) return null;
  const alerts = getRepositories().alerts;
  const counts = {} as Record<Severity, number>;
  for (const sev of SEVERITIES) counts[sev] = (await alerts.query({ service, status: 'OPEN', severity: sev, pageSize: 1 })).total;
  return counts;
}

function serviceOf(t: HealthTarget): string | null {
  if (t.kind === 'http') return t.service;
  if (t.kind === 'placeholder') return t.id;
  return null;
}

function waiting(t: HealthTarget, note: string, hint: string | null, alerts: Record<Severity, number> | null): HealthTargetStatus {
  return {
    id: t.id, name: t.name, description: t.description,
    kind: t.kind === 'placeholder' ? 'placeholder' : t.kind === 'http' ? 'http' : 'builtin',
    status: 'WAITING_FOR_INTEGRATION', dataSource: 'WAITING_FOR_INTEGRATION', note,
    lastCheckedAt: null, latencyMs: null, httpStatus: null, error: null,
    uptime: { '24h': emptyWindow(), '7d': emptyWindow(), '30d': emptyWindow() },
    openAlerts: alerts, series: [], configHint: hint,
  };
}

async function targetStatus(t: HealthTarget, now: Date): Promise<HealthTargetStatus> {
  const alerts = await openAlerts(serviceOf(t));
  if (t.kind === 'placeholder') return waiting(t, WAITING_NOTE, t.configHint, alerts);
  if (t.kind === 'urbani-api' && !config.urbani.logsConfigured) {
    return waiting(t, 'Urbani API is not configured, so it is not probed', URBANI_API_CONFIG_HINT, null);
  }
  const nowMs = now.getTime();
  const results = await getRepositories().health.listResults(t.id, new Date(nowMs - RANGE_MS['30d']).toISOString(), now.toISOString());
  const latest = results.length ? results[results.length - 1] : null;
  const within = (ms: number) => results.filter((r) => Date.parse(r.timestamp) >= nowMs - ms);
  const last24h = within(RANGE_MS['24h']);
  const min = config.health.minSamples;
  const base = {
    id: t.id, name: t.name, description: t.description,
    kind: (t.kind === 'http' ? 'http' : 'builtin') as 'http' | 'builtin',
    uptime: {
      '24h': computeUptime(last24h, min),
      '7d': computeUptime(within(RANGE_MS['7d']), min),
      '30d': computeUptime(results, min),
    },
    openAlerts: alerts,
    series: downsample(toSeries(last24h), SERIES_POINTS),
    configHint: null,
  };
  if (!latest) {
    return { ...base, status: 'UNKNOWN', dataSource: 'WAITING_FOR_INTEGRATION', note: 'Configured; no probe result yet', lastCheckedAt: null, latencyMs: null, httpStatus: null, error: null };
  }
  const stale = nowMs - Date.parse(latest.timestamp) > staleAfterMs();
  const status: HealthStatus = stale ? 'UNKNOWN' : latest.status;
  return {
    ...base,
    status,
    dataSource: stale ? 'WAITING_FOR_INTEGRATION' : 'LIVE',
    note: stale ? 'Last result is stale (background probing may be off); showing history only' : null,
    lastCheckedAt: latest.timestamp,
    latencyMs: latest.latencyMs,
    httpStatus: latest.httpStatus,
    error: latest.error,
  };
}

const toSeries = (rs: HealthCheckResult[]): HealthSeriesPoint[] =>
  rs.map((r) => ({ timestamp: r.timestamp, status: r.status, latencyMs: r.latencyMs }));

export const healthService = {
  async status(now: Date = new Date()): Promise<HealthStatusResponse> {
    const load = loadConfiguredTargets();
    const targets = await Promise.all(load.targets.map((t) => targetStatus(t, now)));
    return {
      generatedAt: now.toISOString(),
      probesEnabled: config.health.probesEnabled,
      intervalSeconds: config.health.intervalSeconds,
      minSamples: config.health.minSamples,
      configErrors: load.errors,
      targets,
    };
  },

  async history(targetId: string, range: HealthRange, now: Date = new Date()): Promise<HealthHistoryResponse> {
    const target = loadConfiguredTargets().targets.find((t) => t.id === targetId);
    if (!target) throw new NotFoundError(`Unknown health target: ${targetId}`);
    if (target.kind === 'placeholder' || (target.kind === 'urbani-api' && !config.urbani.logsConfigured)) {
      return { target: targetId, range, points: [] };
    }
    const rs = await getRepositories().health.listResults(targetId, new Date(now.getTime() - RANGE_MS[range]).toISOString(), now.toISOString());
    return { target: targetId, range, points: downsample(toSeries(rs), HISTORY_POINTS) };
  },

  /** Runs all probes now (joins a run in progress) and returns the fresh status. */
  async checkNow(): Promise<{ checked: number; status: HealthStatusResponse }> {
    const results = await getHealthRunner().runNow();
    return { checked: results.length, status: await healthService.status() };
  },

  /** Retention. 0 days = keep forever. */
  async purgeExpired(now: Date = new Date(), days = config.health.retentionDays): Promise<number | null> {
    if (days <= 0) return null;
    return getRepositories().health.purgeOlderThan(new Date(now.getTime() - days * 86_400_000).toISOString());
  },
};

/** Starts the background probes (never in tests, or when HEALTH_PROBES_ENABLED=false). Returns a stop function. */
export function startHealthProbes(): () => void {
  if (config.isTest) return () => undefined;
  if (!config.health.probesEnabled) {
    logger.info('Health probes not running (HEALTH_PROBES_ENABLED=false)');
    return () => undefined;
  }
  const load = loadConfiguredTargets();
  load.errors.forEach((e) => logger.warn('Health target configuration problem', { problem: e }));
  logger.info('Health probes started', { everySeconds: config.health.intervalSeconds, targets: load.targets.map((t) => t.id) });
  return startHealthScheduler(getHealthRunner(), { intervalMs: config.health.intervalSeconds * 1000 });
}

/** Daily purge of old health results (same pattern as the audit / chat / notification retention jobs). */
export function startHealthRetentionJob(): () => void {
  if (config.isTest || config.health.retentionDays <= 0) return () => undefined;
  const run = () =>
    healthService
      .purgeExpired()
      .then((n) => logger.info('Health retention purge done', { purged: n }))
      .catch((err) => logger.warn('Health retention purge failed', { error: err instanceof Error ? err.message : String(err) }));
  void run();
  const timer = setInterval(run, 24 * 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
