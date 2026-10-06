import { randomUUID } from 'node:crypto';
import type { Severity, UrbaniIncidentAlert } from '@urbani/shared';
import { SEVERITIES, urbaniIncidentAlertSchema } from '@urbani/shared';
import { config } from '../../config';
import { logger } from '../../lib/logger';

/**
 * HttpUrbaniAlertsAdapter (Phase 3 — real AI-generated incidents).
 *
 * Reads the live, Bedrock-generated alerts from the API Gateway endpoints
 * (GET {base}/alerts/latest and GET {base}/alerts/history?limit=N), secured by
 * an x-api-key header, and maps each AWS alert object onto the shared
 * UrbaniIncidentAlert contract so alertService can serve them unchanged.
 *
 * This is a NEW, focused live source consumed by alertService — it is NOT the
 * DynamoDBAdapter interface (putAlert/getAlert/queryAlerts); the mock DynamoDB
 * adapter stays as-is for the analyze pipeline.
 *
 * It mirrors HttpUrbaniLogsAdapter's discipline:
 *  - API key read from env only; never hardcoded, logged, or returned.
 *  - TTL cache aligned to the refresh window; serve stale cache on failure.
 *  - On failure return [] (or stale) rather than breaking the Alerts page.
 */

interface UrbaniAlertObject {
  alertId?: string;
  severity?: string;
  timestamp?: string;
  service_id?: string;
  service?: string;
  environment?: string;
  anomalyType?: string;
  summary?: string;
  probableCause?: string;
  recommendedActions?: unknown;
  evidence?: unknown;
  confidence?: number | string;
  modelId?: string | null;
}

interface LatestResponse {
  service_id?: string;
  alert?: UrbaniAlertObject | null;
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

  private latestCache: CacheEntry | null = null;
  private historyCache: Map<number, CacheEntry> = new Map();
  private readonly ttlMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly service: string,
    refreshMinutes: number,
  ) {
    this.ttlMs = Math.max(refreshMinutes, 1) * 60_000;
  }

  /** The current (latest) alert as a 0-or-1 element array. */
  async getLatest(): Promise<UrbaniIncidentAlert[]> {
    const now = Date.now();
    if (this.latestCache && now - this.latestCache.at < this.ttlMs) {
      return this.latestCache.value;
    }
    try {
      const body = await this.get<LatestResponse>(
        `/alerts/latest?service=${encodeURIComponent(this.service)}`,
      );
      const raw = body.alert ?? null;
      const mapped = raw ? this.mapMany([raw]) : [];
      this.latestCache = { at: now, value: mapped };
      return mapped;
    } catch (err) {
      return this.onFailure('alerts/latest', err, this.latestCache);
    }
  }

  /** The most recent N alerts (history). */
  async getHistory(limit: number): Promise<UrbaniIncidentAlert[]> {
    const n = Math.max(1, Math.floor(limit) || 1);
    const now = Date.now();
    const cached = this.historyCache.get(n);
    if (cached && now - cached.at < this.ttlMs) {
      return cached.value;
    }
    try {
      const body = await this.get<HistoryResponse>(
        `/alerts/history?service=${encodeURIComponent(this.service)}&limit=${n}`,
      );
      const raw = Array.isArray(body.alerts) ? body.alerts : [];
      const mapped = this.mapMany(raw);
      this.historyCache.set(n, { at: now, value: mapped });
      return mapped;
    } catch (err) {
      return this.onFailure('alerts/history', err, this.historyCache.get(n) ?? null);
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
  private mapMany(raw: UrbaniAlertObject[]): UrbaniIncidentAlert[] {
    const out: UrbaniIncidentAlert[] = [];
    for (const o of raw) {
      const mapped = this.mapOne(o);
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

  private mapOne(o: UrbaniAlertObject): UrbaniIncidentAlert {
    return {
      alertId: this.str(o.alertId) ?? randomUUID(),
      timestamp: this.iso(o.timestamp) ?? new Date().toISOString(),
      service: this.str(o.service) ?? this.str(o.service_id) ?? this.service,
      environment: this.str(o.environment) ?? 'production-eb',
      severity: this.severity(o.severity),
      anomalyType: this.str(o.anomalyType) ?? 'UnknownAnomaly',
      summary: this.str(o.summary) ?? '',
      evidence: Array.isArray(o.evidence) ? o.evidence.map((e) => String(e)) : [],
      probableCause: this.str(o.probableCause) ?? '',
      recommendedActions: Array.isArray(o.recommendedActions)
        ? o.recommendedActions.map((a) => String(a))
        : [],
      confidence: this.confidence(o.confidence),
      modelId: this.str(o.modelId ?? undefined) ?? config.urbani.chatModelId,
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

  private confidence(v: unknown): number {
    const n = Number(v);
    if (Number.isNaN(n)) return 0.5;
    return Math.min(Math.max(n, 0), 1);
  }
}
