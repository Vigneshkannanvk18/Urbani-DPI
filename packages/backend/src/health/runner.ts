import { performance } from 'node:perf_hooks';
import { logger } from '../lib/logger';
import type { HealthCheckResult, Repositories } from '../repositories/types';
import { httpProbe, type HttpProbeRequest, type ProbeOutcome, type ProbePolicy } from './httpProbe';
import { redactText } from './ssrf';
import type { HealthTarget, TargetsLoad } from './targets';

/**
 * Probe runner and scheduler (DPI 2 item 9).
 *
 * - Single-flight: while a run is in progress, runNow() joins it instead of starting another (scheduler ticks and
 *   the "Check now" button share this).
 * - Results are stored through the repository layer, one per (target, minute bucket), so concurrent tasks writing
 *   the same minute are idempotent. With 2+ ECS tasks every task probes; that is accepted (see docs/HEALTH.md).
 */
export interface UrbaniApiSettings {
  baseUrl: string | null;
  apiKey: string | null;
  service: string;
}
export interface RunnerDeps {
  repos: () => Repositories;
  load: () => TargetsLoad;
  policy: () => Pick<ProbePolicy, 'allowPrivate' | 'maxResponseBytes'>;
  urbani: () => UrbaniApiSettings;
  now?: () => Date;
  probe?: (req: HttpProbeRequest, policy: ProbePolicy) => Promise<ProbeOutcome>;
}

export class HealthRunner {
  private inflight: Promise<HealthCheckResult[]> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly deps: RunnerDeps) {}

  get running(): boolean {
    return this.inflight !== null;
  }

  /** Probes every configured target once and stores the results. Joins a run already in progress. */
  runNow(): Promise<HealthCheckResult[]> {
    if (this.inflight) return this.inflight;
    this.controller = new AbortController();
    const p = this.runAll(this.controller.signal).finally(() => {
      this.inflight = null;
      this.controller = null;
    });
    this.inflight = p;
    return p;
  }

  /** Aborts probes that are still in flight (shutdown). */
  stop(): void {
    this.controller?.abort();
  }

  private async runAll(signal: AbortSignal): Promise<HealthCheckResult[]> {
    const { targets } = this.deps.load();
    const settled = await Promise.allSettled(targets.map((t) => this.probeTarget(t, signal)));
    const results: HealthCheckResult[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results.push(s.value);
    }
    return results;
  }

  private async probeTarget(target: HealthTarget, signal: AbortSignal): Promise<HealthCheckResult | null> {
    if (target.kind === 'placeholder') return null; // never probed, never stored
    const outcome = await this.outcomeFor(target, signal);
    if (!outcome) return null;
    const timestamp = (this.deps.now ?? (() => new Date()))().toISOString();
    const result: HealthCheckResult = {
      targetId: target.id,
      timestamp,
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      latencyMs: outcome.latencyMs,
      error: outcome.error ? redactText(outcome.error, 200) : null,
    };
    try {
      await this.deps.repos().health.recordResult(result);
    } catch (err) {
      logger.warn('Health result could not be stored', { target: target.id, error: err instanceof Error ? err.message : String(err) });
    }
    return result;
  }

  private async outcomeFor(target: HealthTarget, signal: AbortSignal): Promise<ProbeOutcome | null> {
    const probe = this.deps.probe ?? httpProbe;
    const policy: ProbePolicy = { ...this.deps.policy(), signal };
    switch (target.kind) {
      case 'radar': {
        const started = performance.now();
        try {
          await this.deps.repos().health.ping();
        } catch {
          return { status: 'DOWN', httpStatus: null, latencyMs: null, error: 'database ping failed' };
        }
        const latencyMs = Math.round(performance.now() - started);
        return latencyMs > target.degradedAboveMs
          ? { status: 'DEGRADED', httpStatus: null, latencyMs, error: `slow database ping (${latencyMs} ms)` }
          : { status: 'UP', httpStatus: null, latencyMs, error: null };
      }
      case 'urbani-api': {
        const u = this.deps.urbani();
        if (!u.baseUrl || !u.apiKey) return null; // not configured: shown as WAITING_FOR_INTEGRATION, never probed
        const base = u.baseUrl.endsWith('/') ? u.baseUrl : `${u.baseUrl}/`;
        return probe(
          {
            url: new URL(`logs/latest?service=${encodeURIComponent(u.service)}`, base).toString(),
            method: 'GET',
            headers: { 'x-api-key': u.apiKey },
            expectedStatus: null,
            timeoutMs: 5000,
            degradedAboveMs: 2000,
          },
          policy,
        );
      }
      case 'http':
        return probe(
          {
            url: target.url,
            method: target.method,
            expectedStatus: target.expectedStatus,
            timeoutMs: target.timeoutMs,
            degradedAboveMs: target.degradedAboveMs,
          },
          policy,
        );
      default:
        return null;
    }
  }
}

export interface SchedulerOptions {
  intervalMs: number;
  /** Delay before the first run (jittered by the caller's random). */
  initialDelayMs?: number;
  random?: () => number;
}

/**
 * Self-rescheduling timer: next run = interval x (0.9 .. 1.1), scheduled after the previous run finished (so runs
 * never pile up), unref'd so it never keeps the process alive. Returns a stop function.
 */
export function startHealthScheduler(runner: Pick<HealthRunner, 'runNow' | 'stop'>, opts: SchedulerOptions): () => void {
  const random = opts.random ?? Math.random;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runner.runNow();
    } catch (err) {
      logger.warn('Health probe run failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      schedule(Math.round(opts.intervalMs * (0.9 + 0.2 * random())));
    }
  };
  schedule(opts.initialDelayMs ?? Math.round(1000 + random() * 4000));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    runner.stop();
  };
}
