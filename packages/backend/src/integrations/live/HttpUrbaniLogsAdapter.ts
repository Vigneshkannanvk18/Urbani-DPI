import { randomUUID } from 'node:crypto';
import type {
  CloudWatchAdapter,
  CloudWatchLogQuery,
  CloudWatchMetricQuery,
  WithMeta,
} from '../types';
import type { LogEntry, LogLevel, MetricSnapshot } from '@urbani/shared';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { IntegrationError } from '../../lib/errors';
import { mockMetrics, MOCK_NOTE } from '../mock/mockData';

/**
 * HttpUrbaniLogsAdapter (Phase 3 — real telemetry).
 *
 * Implements the existing CloudWatchAdapter contract against the real Urbani
 * API Gateway endpoint (GET {base}/logs/latest?service=...), secured by an
 * x-api-key header. Nothing above this boundary changes — the service layer and
 * dashboard keep consuming the same interface; only the source label flips to LIVE.
 *
 * SECURITY:
 *  - The API key is read from config (env) only; it is never hardcoded, never
 *    logged, and never sent to the browser (this call is server-side).
 *  - Errors are surfaced as IntegrationError without echoing the key.
 *
 * SCOPE: only /logs/latest is available for the provided key. Metrics fall back
 * to mock (the metrics endpoint returns 403), preserving the provenance system.
 */

const LOG_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

interface UrbaniLogsResponse {
  service_id?: string;
  logs?: unknown[];
  window_start?: string;
  window_end?: string;
  log_count?: string | number;
}

interface CacheEntry {
  at: number;
  value: LogEntry[];
  windowEnd: string | null;
}

export class HttpUrbaniLogsAdapter implements CloudWatchAdapter {
  readonly kind = 'CLOUDWATCH' as const;

  private cache: CacheEntry | null = null;
  private readonly ttlMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly service: string,
    refreshMinutes: number,
  ) {
    // Align caching with the API's refresh window so we poll at most once per cycle.
    this.ttlMs = Math.max(refreshMinutes, 1) * 60_000;
  }

  async getLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>> {
    const all = await this.fetchLatest();

    let items = all;
    if (query.service) items = items.filter((l) => l.service === query.service);
    if (query.environment) items = items.filter((l) => l.environment === query.environment);
    if (query.level) items = items.filter((l) => l.level === query.level);
    if (query.search) {
      const q = query.search.toLowerCase();
      items = items.filter((l) => l.message.toLowerCase().includes(q));
    }
    const limit = Math.min(query.limit ?? 100, 100);
    items = items.slice(0, limit);

    return {
      meta: {
        source: 'LIVE',
        note: `Live Urbani logs (service=${this.service}). Refreshed every ${this.ttlMs / 60000} min.`,
      },
      value: items,
    };
  }

  /**
   * Metrics are not available for this key (endpoint returns 403), so we serve
   * mock data and clearly label it as such — never claim LIVE for unavailable data.
   */
  async getMetrics(query: CloudWatchMetricQuery): Promise<WithMeta<MetricSnapshot[]>> {
    let items = [...mockMetrics];
    if (query.service) items = items.filter((m) => m.service === query.service);
    if (query.environment) items = items.filter((m) => m.environment === query.environment);
    if (query.limit) items = items.slice(0, query.limit);
    return {
      meta: { source: 'MOCK', note: `${MOCK_NOTE} (metrics endpoint not yet available)` },
      value: items,
    };
  }

  private async fetchLatest(): Promise<LogEntry[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) {
      return this.cache.value;
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/logs/latest?service=${encodeURIComponent(this.service)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        signal: controller.signal,
      });

      if (!res.ok) {
        // Do NOT include headers/key in the error.
        throw new IntegrationError(`Urbani logs API returned HTTP ${res.status}`);
      }

      const body = (await res.json()) as UrbaniLogsResponse;
      const mapped = this.mapLogs(body);

      this.cache = { at: now, value: mapped, windowEnd: body.window_end ?? null };
      logger.info('Fetched live Urbani logs', {
        service: this.service,
        count: mapped.length,
        windowEnd: body.window_end,
      });
      return mapped;
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      const message = err instanceof Error ? err.message : 'unknown error';
      // Serve stale cache if we have it, rather than breaking the dashboard.
      if (this.cache) {
        logger.warn('Urbani logs fetch failed; serving cached window', { message });
        return this.cache.value;
      }
      throw new IntegrationError(`Failed to reach Urbani logs API: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Defensive mapping: the upstream log entry shape may vary, so we probe
   *  common field names and always produce a valid LogEntry. */
  private mapLogs(body: UrbaniLogsResponse): LogEntry[] {
    const service = body.service_id ?? this.service;
    const raw = Array.isArray(body.logs) ? body.logs : [];

    return raw.map((entry) => {
      // String log lines are supported too.
      if (typeof entry === 'string') {
        return this.buildEntry(service, {}, entry);
      }
      const o = (entry ?? {}) as Record<string, unknown>;
      const message =
        this.str(o.message) ?? this.str(o['@message']) ?? this.str(o.msg) ?? this.str(o.log) ?? JSON.stringify(o);
      return this.buildEntry(service, o, message);
    });
  }

  private buildEntry(service: string, o: Record<string, unknown>, message: string): LogEntry {
    const timestamp =
      this.iso(o.timestamp) ?? this.iso(o['@timestamp']) ?? this.iso(o.time) ?? new Date().toISOString();
    return {
      id: this.str(o.id) ?? this.str(o.eventId) ?? randomUUID(),
      timestamp,
      level: this.level(o.level ?? o.severity ?? o.logLevel),
      service: this.str(o.service) ?? service,
      environment: this.str(o.environment) ?? this.str(o.env) ?? 'production-eb',
      message,
    };
  }

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  private iso(v: unknown): string | undefined {
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return new Date(t).toISOString();
    }
    if (typeof v === 'number') {
      // Support epoch seconds or milliseconds.
      const ms = v > 1e12 ? v : v * 1000;
      return new Date(ms).toISOString();
    }
    return undefined;
  }

  private level(v: unknown): LogLevel {
    const s = typeof v === 'string' ? v.toUpperCase() : '';
    if ((LOG_LEVELS as string[]).includes(s)) return s as LogLevel;
    if (s === 'WARNING') return 'WARN';
    if (s === 'ERR' || s === 'CRITICAL' || s === 'CRIT') return 'ERROR';
    return 'INFO';
  }
}
