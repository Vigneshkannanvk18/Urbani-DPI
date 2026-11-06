import type { Severity } from './alerts';
import type { DataSource } from './common';

/**
 * Service health vocabulary shared by backend and frontend (DPI 2 item 9).
 * Honesty rules: WAITING_FOR_INTEGRATION is never shown as UP/LIVE; UNKNOWN = configured but no result yet.
 */
export const PROBE_STATUSES = ['UP', 'DEGRADED', 'DOWN'] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

export const HEALTH_STATUSES = ['UP', 'DEGRADED', 'DOWN', 'UNKNOWN', 'WAITING_FOR_INTEGRATION'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const HEALTH_RANGES = ['24h', '7d', '30d'] as const;
export type HealthRange = (typeof HEALTH_RANGES)[number];

export interface UptimeWindow {
  /** Percent of samples that were UP (0-100, 2 decimals); null when there are too few samples. */
  uptimePct: number | null;
  samples: number;
  insufficientData: boolean;
}

export interface HealthSeriesPoint {
  timestamp: string;
  status: ProbeStatus;
  latencyMs: number | null;
}

export interface HealthTargetStatus {
  id: string;
  name: string;
  /** What this target actually measures (shown verbatim in the UI). */
  description: string;
  kind: 'builtin' | 'http' | 'placeholder';
  status: HealthStatus;
  /** LIVE only when the target was actually probed; otherwise WAITING_FOR_INTEGRATION. */
  dataSource: DataSource;
  note: string | null;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  httpStatus: number | null;
  error: string | null;
  uptime: { '24h': UptimeWindow; '7d': UptimeWindow; '30d': UptimeWindow };
  openAlerts: Record<Severity, number> | null;
  series: HealthSeriesPoint[];
  /** For WAITING_FOR_INTEGRATION targets: the exact setting that enables the probe. */
  configHint: string | null;
}

export interface HealthStatusResponse {
  generatedAt: string;
  probesEnabled: boolean;
  intervalSeconds: number;
  minSamples: number;
  configErrors: string[];
  targets: HealthTargetStatus[];
}

export interface HealthHistoryResponse {
  target: string;
  range: HealthRange;
  points: HealthSeriesPoint[];
}
