import type {
  CloudWatchAdapter,
  CloudWatchLogQuery,
  CloudWatchMetricQuery,
  WithMeta,
} from '../types';
import type { LogEntry, MetricSnapshot, UrbaniIncidentAlert } from '@urbani/shared';
import { logger } from '../../lib/logger';
import { mockMetrics, MOCK_NOTE } from '../mock/mockData';
import {
  parseLogLine,
  stableSortDesc,
  dedupeByNaturalKey,
  parseMs,
  str,
  type LogTuple,
} from './logLineParser';

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
 * ALERT-EVIDENCE FALLBACK: the QA /logs/* windows frequently expose only
 * "relevant" (flagged) lines, so logs[] is often empty even though real log
 * lines DO exist upstream — inside each alert's `evidence` array. When an
 * alerts source is wired in, this adapter ALSO parses those evidence strings
 * (same line parser) into LogEntry rows and merges them with the /logs/* lines.
 * These are genuine upstream lines, not fabrication, so the LIVE label stays
 * honest. When nothing is available from either channel the window is legitimately
 * empty.
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

/** A source of recent live alerts, used to surface alert-evidence log lines. */
export interface AlertEvidenceSource {
  getLatest(): Promise<UrbaniIncidentAlert[]>;
  getHistory(limit: number): Promise<UrbaniIncidentAlert[]>;
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

  /**
   * Optional alerts source. When wired, the adapter surfaces each alert's
   * `evidence` strings as LogEntry rows so the Logs page shows the real log
   * lines that the /logs/* windows omit. Injected post-construction (the alerts
   * adapter is built in the same factory) to avoid a constructor cycle.
   */
  private alertEvidence?: AlertEvidenceSource;
  private readonly alertsHistoryLimit: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    service: string,
    refreshMinutes: number,
    historyLimit = 20,
    services?: string[],
    environment = 'qa',
    alertsHistoryLimit = 20,
  ) {
    // Align caching with the API's refresh window so we poll at most once per cycle.
    this.ttlMs = Math.max(refreshMinutes, 1) * 60_000;
    this.historyLimit = Math.max(1, Math.floor(historyLimit) || 1);
    this.services = services && services.length ? services : [service];
    this.environment = environment;
    this.alertsHistoryLimit = Math.max(1, Math.floor(alertsHistoryLimit) || 1);
  }

  /** Wire the alerts source so alert-evidence lines can backfill empty windows. */
  setAlertEvidenceSource(source: AlertEvidenceSource): void {
    this.alertEvidence = source;
  }

  async getLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>> {
    // Fetch the requested service (if enabled), else fan out across all enabled.
    const target =
      query.service && this.services.includes(query.service) ? [query.service] : this.services;

    const [perService, evidenceTuples] = await Promise.all([
      Promise.all(target.map((svc) => this.fetchService(svc))),
      this.fetchAlertEvidence(target),
    ]);
    const merged = [...perService.flatMap((p) => p.tuples), ...evidenceTuples];
    // Degraded ONLY when EVERY targeted /logs/* service failed upstream AND
    // nothing came back from logs OR alert evidence — so a partial success or
    // any lines (including evidence lines) keep the honest LIVE label, and a
    // successful-but-empty window stays LIVE too.
    const allLogsFailed = perService.length > 0 && perService.every((p) => p.failed);
    const anyLines = merged.length > 0;

    // De-dup across both channels on the natural key so a line present in both a
    // log window and an alert's evidence collapses to one row (stable id).
    let tuples = dedupeByNaturalKey(merged);
    if (query.service) tuples = tuples.filter((t) => t.entry.service === query.service);
    if (query.environment) tuples = tuples.filter((t) => t.entry.environment === query.environment);
    if (query.level) tuples = tuples.filter((t) => t.entry.level === query.level);
    if (query.search) {
      const q = query.search.toLowerCase();
      tuples = tuples.filter((t) => t.entry.message.toLowerCase().includes(q));
    }

    // Stable descending sort on sortKeyMs: an unresolved timestamp is -Infinity
    // and therefore sorts LAST, never first.
    const sorted = stableSortDesc(tuples);
    const limit = Math.min(query.limit ?? 100, 100);
    const items = sorted.slice(0, limit).map((t) => t.entry);

    // A fully-failed /logs/* fetch with no lines from any channel is degraded:
    // label WAITING_FOR_INTEGRATION so the Logs page shows "temporarily
    // unavailable" instead of a bare empty state.
    if (allLogsFailed && !anyLines) {
      return {
        meta: {
          source: 'WAITING_FOR_INTEGRATION',
          note: 'Live Urbani logs temporarily unavailable (upstream fetch failed).',
        },
        value: items,
      };
    }

    const evidenceBacked = evidenceTuples.length > 0;
    const note = evidenceBacked
      ? `Live Urbani logs (services=${this.services.join(', ')}). Latest + history, plus lines surfaced from recent incident evidence when the live log window exposes none. Refreshed every ${this.ttlMs / 60000} min.`
      : `Live Urbani logs (services=${this.services.join(', ')}). Latest + history, refreshed every ${this.ttlMs / 60000} min.`;

    return {
      meta: { source: 'LIVE', note },
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
   * Surface the real log lines carried in recent alerts' `evidence` arrays as
   * LogEntry tuples, scoped to the targeted services. Each evidence string is a
   * JSON-stringified log entry OR a plain message; the SAME line parser is used
   * so level/timestamp/message/id/dedup stay consistent with /logs/* lines. The
   * alert's own timestamp is the fallback when an evidence entry has none.
   *
   * Best-effort: a failure here must never break the Logs page, and an absent
   * alerts source or empty evidence yields NO lines (never fabricated).
   */
  private async fetchAlertEvidence(target: string[]): Promise<LogTuple[]> {
    if (!this.alertEvidence) return [];
    try {
      const [latest, history] = await Promise.all([
        this.alertEvidence.getLatest(),
        this.alertEvidence.getHistory(this.alertsHistoryLimit),
      ]);
      // De-dup alerts by id (latest may also appear in history).
      const byId = new Map<string, UrbaniIncidentAlert>();
      for (const a of [...history, ...latest]) byId.set(a.alertId, a);

      const wanted = new Set(target);
      const tuples: LogTuple[] = [];
      for (const alert of byId.values()) {
        if (!wanted.has(alert.service)) continue;
        const fallbackMs = parseMs(alert.timestamp);
        for (const line of alert.evidence) {
          if (!str(line)) continue;
          tuples.push(
            parseLogLine(line, {
              service: alert.service,
              environment: this.environment,
              fallbackMs,
            }),
          );
        }
      }
      return tuples;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn('Alert-evidence log backfill failed; serving /logs/* lines only', { message });
      return [];
    }
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
    // consistent. Latest wins on a tie (listed first).
    const tuples = dedupeByNaturalKey([...latest.tuples, ...history.tuples]);
    return { tuples, failed: latest.failed && history.failed };
  }

  private async fetchLatest(service: string): Promise<ServiceFetch> {
    const now = Date.now();
    const cached = this.latestCache.get(service);
    if (cached && now - cached.at < this.ttlMs) return { tuples: cached.value, failed: false };
    try {
      const body = await this.get<UrbaniLatestResponse>(
        `/logs/latest?service=${encodeURIComponent(service)}`,
      );
      const svc = str(body.service_id) ?? service;
      const windowEndMs = parseMs(body.window_end);
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
      const svc = str(body.service_id) ?? service;
      const tuples: LogTuple[] = [];
      const windows = Array.isArray(body.windows) ? body.windows : [];
      for (const w of windows) {
        const windowEndMs = parseMs(w.window_end);
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

  /** Map one QA log line via the shared parser, stamping service + environment. */
  private mapLine(service: string, raw: unknown, windowEndMs: number | undefined): LogTuple {
    return parseLogLine(raw, { service, environment: this.environment, fallbackMs: windowEndMs });
  }
}
