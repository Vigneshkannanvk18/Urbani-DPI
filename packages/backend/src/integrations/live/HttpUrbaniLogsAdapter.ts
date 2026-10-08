import { createHash } from 'node:crypto';
import type {
  CloudWatchAdapter,
  CloudWatchLogQuery,
  CloudWatchMetricQuery,
  WithMeta,
} from '../types';
import type { LogEntry, LogLevel, MetricSnapshot } from '@urbani/shared';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { mockMetrics, MOCK_NOTE } from '../mock/mockData';

/**
 * HttpUrbaniLogsAdapter (Phase 3 — real QA telemetry).
 *
 * Implements the existing CloudWatchAdapter contract against the real Urbani QA
 * API Gateway endpoints, secured by an x-api-key header. Nothing above this
 * boundary changes — the service layer and dashboard keep consuming the same
 * interface; only the source label flips to LIVE.
 *
 * It reads BOTH:
 *   GET {base}/logs/latest?service=<svc>   -> { ..., logs:[{timestamp,message}] }
 *   GET {base}/logs/history?service=<svc>&limit=N
 *                                          -> { ..., windows:[{...,logs:[...]}] }
 * flattens windows[].logs[], merges latest ∪ history, de-duplicates and sorts
 * newest-first. QA log entries carry only timestamp + message (NO level) — the
 * level is INFERRED from the message text (defensively unwrapping a JSON-string
 * message with an embedded level if present).
 *
 * SECURITY:
 *  - The API key is read from config (env) only; it is never hardcoded, never
 *    logged, and never sent to the browser (this call is server-side).
 *  - On any upstream non-200 / timeout the adapter DEGRADES to stale cache or []
 *    (it never throws), so the Logs page never 500s.
 *
 * SCOPE: metrics fall back to mock (QA exposes no metrics endpoint), preserving
 * the provenance system.
 */

const LOG_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

interface UrbaniLogLine {
  timestamp?: unknown;
  message?: unknown;
}

interface UrbaniLatestResponse {
  service_id?: string;
  window_start?: string;
  window_end?: string;
  log_count?: string | number;
  logs?: unknown[];
}

interface UrbaniHistoryWindow {
  window_start?: string;
  window_end?: string;
  source_log_group?: string;
  log_count?: string | number;
  logs?: unknown[];
}

interface UrbaniHistoryResponse {
  service_id?: string;
  count?: number;
  windows?: UrbaniHistoryWindow[];
  // Defensive fallback: some deployments return a flat top-level logs[].
  logs?: unknown[];
}

/** A mapped entry carrying its (ordering-only) sort key. */
interface LogTuple {
  entry: LogEntry;
  sortKeyMs: number;
}

/**
 * Result of a per-service fetch. `failed` is true ONLY when an upstream call
 * errored (non-200 / timeout / network) with NO cache to fall back on — i.e. a
 * genuinely-degraded fetch, distinguishable from a successful-but-empty window.
 * Serving stale cache counts as a success (failed=false).
 */
interface ServiceFetch {
  tuples: LogTuple[];
  failed: boolean;
}

interface CacheEntry {
  at: number;
  value: LogTuple[];
}

export class HttpUrbaniLogsAdapter implements CloudWatchAdapter {
  readonly kind = 'CLOUDWATCH' as const;

  /** Per-service caches (latest + history refresh independently). */
  private latestCache: Map<string, CacheEntry> = new Map();
  private historyCache: Map<string, CacheEntry> = new Map();
  private readonly ttlMs: number;

  private readonly historyLimit: number;

  /** All enabled services (e.g. ['main','payments']); first is the default. */
  private readonly services: string[];

  /** Urbani environment label stamped onto every mapped entry. */
  private readonly environment: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    service: string,
    refreshMinutes: number,
    historyLimit = 20,
    services?: string[],
    environment = 'qa',
  ) {
    // Align caching with the API's refresh window so we poll at most once per cycle.
    this.ttlMs = Math.max(refreshMinutes, 1) * 60_000;
    this.historyLimit = Math.max(1, Math.floor(historyLimit) || 1);
    this.services = services && services.length ? services : [service];
    this.environment = environment;
  }

  async getLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>> {
    // Fetch the requested service (if enabled), else fan out across all enabled.
    const target =
      query.service && this.services.includes(query.service) ? [query.service] : this.services;

    const perService = await Promise.all(target.map((svc) => this.fetchService(svc)));
    const merged = perService.flatMap((p) => p.tuples);
    // Degraded ONLY when EVERY targeted service failed upstream AND nothing came
    // back — so a partial success or any lines keep the honest LIVE label, and a
    // successful-but-empty window stays LIVE too.
    const allFailed = perService.length > 0 && perService.every((p) => p.failed);

    // Filter on the mapped entry.
    let tuples = merged;
    if (query.service) tuples = tuples.filter((t) => t.entry.service === query.service);
    if (query.environment) tuples = tuples.filter((t) => t.entry.environment === query.environment);
    if (query.level) tuples = tuples.filter((t) => t.entry.level === query.level);
    if (query.search) {
      const q = query.search.toLowerCase();
      tuples = tuples.filter((t) => t.entry.message.toLowerCase().includes(q));
    }

    // Stable descending sort on sortKeyMs: an unresolved timestamp is -Infinity
    // and therefore sorts LAST, never first.
    const sorted = this.stableSortDesc(tuples);
    const limit = Math.min(query.limit ?? 100, 100);
    const items = sorted.slice(0, limit).map((t) => t.entry);

    // A fully-failed, empty fetch is degraded: label WAITING_FOR_INTEGRATION so
    // the Logs page can show "temporarily unavailable" instead of a bare empty
    // state. Any lines (even stale cache) keep the honest LIVE label.
    if (allFailed && items.length === 0) {
      return {
        meta: {
          source: 'WAITING_FOR_INTEGRATION',
          note: 'Live Urbani logs temporarily unavailable (upstream fetch failed).',
        },
        value: items,
      };
    }

    return {
      meta: {
        source: 'LIVE',
        note: `Live Urbani logs (services=${this.services.join(', ')}). Latest + history, refreshed every ${this.ttlMs / 60000} min.`,
      },
      value: items,
    };
  }

  /**
   * Metrics are not available on QA (no metrics endpoint), so we serve mock data
   * and clearly label it MOCK — never claim LIVE for unavailable data.
   */
  async getMetrics(query: CloudWatchMetricQuery): Promise<WithMeta<MetricSnapshot[]>> {
    let items = [...mockMetrics];
    if (query.service) items = items.filter((m) => m.service === query.service);
    if (query.environment) items = items.filter((m) => m.environment === query.environment);
    if (query.limit) items = items.slice(0, query.limit);
    return {
      meta: { source: 'MOCK', note: `${MOCK_NOTE} (metrics endpoint not available on QA)` },
      value: items,
    };
  }

  /**
   * Fetch latest ∪ history for one service, merged + de-duplicated. The service
   * fetch is considered failed only when BOTH halves failed upstream (and had no
   * cache) — a partial success is still a success.
   */
  private async fetchService(service: string): Promise<ServiceFetch> {
    const [latest, history] = await Promise.all([
      this.fetchLatest(service),
      this.fetchHistory(service),
    ]);
    // De-dup on the natural key (same key used for the id hash) so id/dedup stay
    // consistent. Latest wins on a tie (fetched first below).
    const byKey = new Map<string, LogTuple>();
    for (const t of [...latest.tuples, ...history.tuples]) {
      const key = this.naturalKey(t.entry.service, t.sortKeyMs, t.entry.message);
      if (!byKey.has(key)) byKey.set(key, t);
    }
    return { tuples: [...byKey.values()], failed: latest.failed && history.failed };
  }

  private async fetchLatest(service: string): Promise<ServiceFetch> {
    const now = Date.now();
    const cached = this.latestCache.get(service);
    if (cached && now - cached.at < this.ttlMs) return { tuples: cached.value, failed: false };
    try {
      const body = await this.get<UrbaniLatestResponse>(
        `/logs/latest?service=${encodeURIComponent(service)}`,
      );
      const svc = this.str(body.service_id) ?? service;
      const windowEndMs = this.parseMs(body.window_end);
      const raw = Array.isArray(body.logs) ? body.logs : [];
      const tuples = raw.map((entry) => this.mapLine(svc, entry, windowEndMs));
      this.latestCache.set(service, { at: now, value: tuples });
      logger.info('Fetched live Urbani logs (latest)', { service, count: tuples.length });
      return { tuples, failed: false };
    } catch (err) {
      return this.onFailure('logs/latest', service, err, this.latestCache.get(service) ?? null);
    }
  }

  private async fetchHistory(service: string): Promise<ServiceFetch> {
    const now = Date.now();
    const key = `${service}:${this.historyLimit}`;
    const cached = this.historyCache.get(key);
    if (cached && now - cached.at < this.ttlMs) return { tuples: cached.value, failed: false };
    try {
      const body = await this.get<UrbaniHistoryResponse>(
        `/logs/history?service=${encodeURIComponent(service)}&limit=${this.historyLimit}`,
      );
      const svc = this.str(body.service_id) ?? service;
      const tuples: LogTuple[] = [];
      const windows = Array.isArray(body.windows) ? body.windows : [];
      for (const w of windows) {
        const windowEndMs = this.parseMs(w.window_end);
        const lines = Array.isArray(w.logs) ? w.logs : [];
        for (const line of lines) tuples.push(this.mapLine(svc, line, windowEndMs));
      }
      // Defensive: accept a flat top-level logs[] too.
      if (!windows.length && Array.isArray(body.logs)) {
        for (const line of body.logs) tuples.push(this.mapLine(svc, line, undefined));
      }
      this.historyCache.set(key, { at: now, value: tuples });
      logger.info('Fetched live Urbani logs (history)', { service, count: tuples.length });
      return { tuples, failed: false };
    } catch (err) {
      return this.onFailure('logs/history', service, err, this.historyCache.get(key) ?? null);
    }
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${pathAndQuery}`;
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
        throw new Error(`Urbani logs API returned HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Serve stale cache on failure if present (a success, failed=false), else an
   * empty degraded result (failed=true). Never throws, never leaks the key.
   */
  private onFailure(
    which: string,
    service: string,
    err: unknown,
    cache: CacheEntry | null,
  ): ServiceFetch {
    const message = err instanceof Error ? err.message : 'unknown error';
    if (cache) {
      logger.warn(`Urbani ${which} fetch failed; serving cached window`, { service, message });
      return { tuples: cache.value, failed: false };
    }
    logger.warn(`Urbani ${which} fetch failed; serving empty window`, { service, message });
    return { tuples: [], failed: true };
  }

  /**
   * Map one QA log line ({timestamp, message}) into a LogEntry + its sort key.
   * The message may be plain text OR a stringified JSON event carrying an
   * embedded level/message — unwrap it so the real level/message surface.
   */
  private mapLine(service: string, raw: unknown, windowEndMs: number | undefined): LogTuple {
    let tsRaw: unknown;
    let rawMessage: string | undefined;
    let inner: Record<string, unknown> | undefined;

    if (typeof raw === 'string') {
      inner = this.tryParseJson(raw);
      if (inner) {
        tsRaw = inner.timestamp;
        rawMessage = this.innerMessage(inner, raw);
      } else {
        rawMessage = raw;
      }
    } else {
      const o = (raw ?? {}) as UrbaniLogLine & Record<string, unknown>;
      tsRaw = o.timestamp;
      const msgField = this.str(o.message);
      inner = msgField ? this.tryParseJson(msgField) : undefined;
      if (inner) {
        if (inner.timestamp !== undefined) tsRaw = inner.timestamp;
        rawMessage = this.innerMessage(inner, msgField);
      } else {
        rawMessage = msgField ?? JSON.stringify(o);
      }
    }

    const message = rawMessage ?? '';
    const parsedEntryMs = this.parseMs(tsRaw);
    // sortKeyMs governs ORDERING only: entry ts -> enclosing window_end -> -Infinity.
    const sortKeyMs = parsedEntryMs ?? windowEndMs ?? Number.NEGATIVE_INFINITY;

    // Human-facing display timestamp has its OWN fallback (ts -> window_end -> now).
    const displayMs = parsedEntryMs ?? windowEndMs ?? Date.now();
    const timestamp = new Date(displayMs).toISOString();

    const level = inner ? this.inferLevelWithEmbedded(inner, message) : this.inferLevel(message);

    const entry: LogEntry = {
      id: this.deterministicId(service, sortKeyMs, message),
      timestamp,
      level,
      service,
      environment: this.environment,
      message,
    };
    return { entry, sortKeyMs };
  }

  /** Natural key used BOTH for dedup and for the deterministic id hash. */
  private naturalKey(service: string, sortKeyMs: number, message: string): string {
    return `${service}|${sortKeyMs}|${message}`;
  }

  /** Deterministic, bounded id (stable across re-fetch; good React key). */
  private deterministicId(service: string, sortKeyMs: number, message: string): string {
    const shortHash = createHash('sha1')
      .update(this.naturalKey(service, sortKeyMs, message))
      .digest('hex')
      .slice(0, 12);
    return `${service}:${sortKeyMs}:${shortHash}`;
  }

  /** Stable descending sort by sortKeyMs (keeps upstream order for equal keys). */
  private stableSortDesc(tuples: LogTuple[]): LogTuple[] {
    return tuples
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (b.t.sortKeyMs - a.t.sortKeyMs) || (a.i - b.i))
      .map((x) => x.t);
  }

  /** Parse a string that may be a JSON object; return undefined if it isn't. */
  private tryParseJson(s: string): Record<string, unknown> | undefined {
    const t = s.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
    try {
      const parsed = JSON.parse(t);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private innerMessage(inner: Record<string, unknown>, fallback: string | undefined): string {
    return this.str(inner.message) ?? this.str(inner.msg) ?? fallback ?? JSON.stringify(inner);
  }

  /** Level from an embedded explicit field if present, else inferred from text. */
  private inferLevelWithEmbedded(inner: Record<string, unknown>, message: string): LogLevel {
    const explicit = this.normalizeLevel(inner.level ?? inner.severity ?? inner.logLevel);
    return explicit ?? this.inferLevel(message);
  }

  /** Normalize an explicit level string to a LogLevel, or undefined if unknown. */
  private normalizeLevel(v: unknown): LogLevel | undefined {
    const s = typeof v === 'string' ? v.toUpperCase() : '';
    if (!s) return undefined;
    if ((LOG_LEVELS as string[]).includes(s)) return s as LogLevel;
    if (s === 'WARNING') return 'WARN';
    if (s === 'CRIT' || s === 'CRITICAL') return 'FATAL';
    if (s === 'ERR') return 'ERROR';
    if (s === 'TRACE') return 'DEBUG';
    return undefined;
  }

  /**
   * Infer a level from the message text (QA logs carry no level field).
   * Case-insensitive, word-boundary, priority order.
   */
  private inferLevel(message: string): LogLevel {
    const m = message;
    if (/\b(FATAL|CRITICAL)\b/i.test(m)) return 'FATAL';
    if (/\b(ERROR|ERR|EXCEPTION|FAIL|FAILED|TIMEOUT)\b/i.test(m)) return 'ERROR';
    if (/\b(WARN|WARNING)\b/i.test(m)) return 'WARN';
    if (/\b(DEBUG|TRACE)\b/i.test(m)) return 'DEBUG';
    return 'INFO';
  }

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  /** Parse an ISO string / epoch number to ms; undefined when unparseable. */
  private parseMs(v: unknown): number | undefined {
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v > 1e12 ? v : v * 1000;
    }
    return undefined;
  }
}
