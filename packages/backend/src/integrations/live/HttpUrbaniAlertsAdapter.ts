import type { Severity, UrbaniIncidentAlert } from '@urbani/shared';
import { SEVERITIES, urbaniIncidentAlertSchema } from '@urbani/shared';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { tryParseJson, str as strOrUndef } from './logLineParser';

/**
 * HttpUrbaniAlertsAdapter (Phase 3 — real AI-generated QA incidents).
 *
 * Reads the live, Bedrock-generated alerts from the QA API Gateway endpoints
 * (GET {base}/alerts/latest and GET {base}/alerts/history?limit=N), secured by
 * an x-api-key header, and maps each FLAT, top-level, snake_case alert object
 * onto the shared UrbaniIncidentAlert contract so alertService can serve them
 * unchanged.
 *
 * This is a NEW, focused live source consumed by alertService — it is NOT the
 * DynamoDBAdapter interface (putAlert/getAlert/queryAlerts).
 *
 * It mirrors HttpUrbaniLogsAdapter's discipline:
 *  - API key read from env only; never hardcoded, logged, or returned.
 *  - TTL cache aligned to the refresh window; serve stale cache on failure.
 *  - On failure return [] (or stale) rather than breaking the Alerts page.
 */

/** The real QA alert shape: FLAT, top-level, snake_case. */
interface UrbaniAlertObject {
  service_id?: string;
  timestamp?: string;
  alert_id?: string;
  anomaly_type?: string;
  severity?: string;
  summary?: string;
  probable_cause?: string;
  recommendation?: string;
  /**
   * Real log lines that justify the alert. The QA API carries these as an array
   * whose entries are EITHER a JSON-stringified log entry ({timestamp,level,
   * message}) OR a plain message string.
   */
  evidence?: unknown[];
}

interface HistoryResponse {
  service_id?: string;
  count?: number;
  alerts?: UrbaniAlertObject[];
}

interface CacheEntry {
  at: number;
  value: UrbaniIncidentAlert[];
}

export class HttpUrbaniAlertsAdapter {
  readonly kind = 'URBANI_ALERTS' as const;

  /** Per-service caches so each service is polled at most once per window. */
  private latestCache: Map<string, CacheEntry> = new Map();
  private historyCache: Map<string, CacheEntry> = new Map();
  private readonly ttlMs: number;

  /** All enabled services (e.g. ['main','payments']); first is the default. */
  private readonly services: string[];

  /** Urbani environment label stamped onto every mapped alert. */
  private readonly environment: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    service: string,
    refreshMinutes: number,
    services?: string[],
    environment = 'qa',
  ) {
    this.ttlMs = Math.max(refreshMinutes, 1) * 60_000;
    this.services = services && services.length ? services : [service];
    this.environment = environment;
  }

  /** The current (latest) alert across all enabled services. */
  async getLatest(): Promise<UrbaniIncidentAlert[]> {
    const perService = await Promise.all(this.services.map((svc) => this.getLatestFor(svc)));
    return perService.flat();
  }

  private async getLatestFor(service: string): Promise<UrbaniIncidentAlert[]> {
    const now = Date.now();
    const cached = this.latestCache.get(service);
    if (cached && now - cached.at < this.ttlMs) {
      return cached.value;
    }
    try {
      // The real /alerts/latest body IS the alert (flat, top-level) — not wrapped.
      const body = await this.get<UrbaniAlertObject>(
        `/alerts/latest?service=${encodeURIComponent(service)}`,
      );
      // No alert_id means "no current alert" for this service.
      const mapped =
        body && typeof body.alert_id === 'string' && body.alert_id.length > 0
          ? this.mapMany([body], service)
          : [];
      this.latestCache.set(service, { at: now, value: mapped });
      return mapped;
    } catch (err) {
      return this.onFailure('alerts/latest', err, this.latestCache.get(service) ?? null);
    }
  }

  /** The most recent N alerts (history) across all enabled services. */
  async getHistory(limit: number): Promise<UrbaniIncidentAlert[]> {
    const n = Math.max(1, Math.floor(limit) || 1);
    const perService = await Promise.all(this.services.map((svc) => this.getHistoryFor(svc, n)));
    return perService.flat();
  }

  private async getHistoryFor(service: string, n: number): Promise<UrbaniIncidentAlert[]> {
    const now = Date.now();
    const key = `${service}:${n}`;
    const cached = this.historyCache.get(key);
    if (cached && now - cached.at < this.ttlMs) {
      return cached.value;
    }
    try {
      const body = await this.get<HistoryResponse>(
        `/alerts/history?service=${encodeURIComponent(service)}&limit=${n}`,
      );
      const raw = Array.isArray(body.alerts) ? body.alerts : [];
      // Skip entries with no alert_id (defensive; mapMany validates the rest).
      const mapped = this.mapMany(
        raw.filter((o) => typeof o.alert_id === 'string' && o.alert_id.length > 0),
        service,
      );
      this.historyCache.set(key, { at: now, value: mapped });
      return mapped;
    } catch (err) {
      return this.onFailure('alerts/history', err, this.historyCache.get(key) ?? null);
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
        throw new Error(`Urbani alerts API returned HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Serve stale cache on failure if present, else []. Never leak the key. */
  private onFailure(
    which: string,
    err: unknown,
    cache: CacheEntry | null,
  ): UrbaniIncidentAlert[] {
    const message = err instanceof Error ? err.message : 'unknown error';
    if (cache) {
      logger.warn(`Urbani ${which} fetch failed; serving cached alerts`, { message });
      return cache.value;
    }
    logger.warn(`Urbani ${which} fetch failed; serving empty alert set`, { message });
    return [];
  }

  /** Map + validate each AWS alert object; skip malformed entries defensively. */
  private mapMany(raw: UrbaniAlertObject[], service: string): UrbaniIncidentAlert[] {
    const out: UrbaniIncidentAlert[] = [];
    for (const o of raw) {
      const mapped = this.mapOne(o, service);
      const parsed = urbaniIncidentAlertSchema.safeParse(mapped);
      if (parsed.success) {
        out.push(parsed.data);
      } else {
        logger.warn('Skipping malformed Urbani alert', {
          alertId: mapped.alertId,
          issues: parsed.error.issues.map((i) => i.path.join('.')),
        });
      }
    }
    return out;
  }

  private mapOne(o: UrbaniAlertObject, service: string): UrbaniIncidentAlert {
    const recommendation =
      typeof o.recommendation === 'string' && o.recommendation.trim() ? o.recommendation : undefined;
    return {
      alertId: this.str(o.alert_id) ?? '',
      timestamp: this.iso(o.timestamp) ?? new Date().toISOString(),
      service: this.str(o.service_id) ?? service,
      environment: this.environment,
      severity: this.severity(o.severity),
      anomalyType: this.str(o.anomaly_type) ?? 'UnknownAnomaly',
      summary: this.str(o.summary) ?? '',
      // Real upstream evidence lines, mapped to human-readable messages. Never
      // fabricated: an absent/empty evidence array yields [].
      evidence: this.mapEvidence(o.evidence),
      probableCause: this.str(o.probable_cause) ?? '',
      // recommendation is a SINGULAR STRING -> single-element array (never split).
      recommendedActions: recommendation ? [recommendation] : [],
      // QA returns no model confidence score. Rather than leave this null (which
      // reads as "data missing"), we populate a DERIVED heuristic from severity.
      // This is NOT a model-reported score. Provenance makes the label
      // unambiguous: the UI treats "a LIVE alert with a non-null confidence" as
      // implicitly derived and labels it accordingly (no shared-schema flag is
      // required). The confidence stays nullable end-to-end.
      confidence: this.deriveConfidence(this.severity(o.severity)),
      modelId: config.urbani.chatModelId,
    };
  }

  /**
   * Derive a confidence score from severity alone. Clamped to [0,1], rounded to
   * 2 decimals. DERIVED, not model-reported — the live QA source returns no
   * confidence score, so this is a severity-based heuristic surfaced with a
   * "(derived)" label in the UI.
   */
  private deriveConfidence(severity: Severity): number {
    const bySeverity: Record<Severity, number> = {
      CRITICAL: 0.9,
      HIGH: 0.8,
      MEDIUM: 0.7,
      LOW: 0.6,
    };
    const raw = bySeverity[severity] ?? 0.7;
    return Math.round(Math.min(Math.max(raw, 0), 1) * 100) / 100;
  }

  /**
   * Map the raw upstream evidence array onto human-readable message strings for
   * the shared UrbaniIncidentAlert.evidence: string[] field. Each entry is
   * either a JSON-stringified log entry (take its .message) or a plain string
   * (use verbatim — Spanish text is preserved as-is). Non-string entries are
   * skipped. An absent/empty array yields [] — never fabricate.
   */
  private mapEvidence(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      const s = strOrUndef(item);
      if (!s) continue;
      const inner = tryParseJson(s);
      const message = inner ? (strOrUndef(inner.message) ?? strOrUndef(inner.msg) ?? s) : s;
      out.push(message);
    }
    return out;
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
      const ms = v > 1e12 ? v : v * 1000;
      return new Date(ms).toISOString();
    }
    return undefined;
  }

  private severity(v: unknown): Severity {
    const s = typeof v === 'string' ? v.toUpperCase() : '';
    if ((SEVERITIES as readonly string[]).includes(s)) return s as Severity;
    return 'MEDIUM';
  }
}
