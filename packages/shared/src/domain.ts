import { z } from 'zod';
import { SEVERITIES, ALERT_STATUSES } from './alerts';

/** Log severity levels for the Logs module (Epic 6). */
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Operational status of a monitored service (Epic 9). */
export const SERVICE_STATUSES = ['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export interface ServiceSummary {
  id: string;
  name: string;
  environment: string;
  status: ServiceStatus;
  lastTelemetryAt: string | null;
  alertCount: number;
  errorRate: number;
  lastIncidentAt: string | null;
  /**
   * Whether this service is enabled upstream (membership in config.urbani.services).
   * OPTIONAL + derived-at-read in the service layer — the raw SQLite row does not
   * carry it, so declaring it optional keeps the repository mapping migration-free.
   */
  enabled?: boolean;
  /** The CloudWatch/ECS log group for this service (derived-at-read). */
  logGroup?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  service: string;
  environment: string;
  message: string;
}

export interface MetricSnapshot {
  id: string;
  service: string;
  environment: string;
  timestamp: string;
  cpuPercent: number;
  memoryPercent: number;
  errorRate: number;
  requestCount: number;
  latencyMsP95: number;
  http5xxCount: number;
  instanceRestarts: number;
}

/** Cost/usage tracking (Epic 10). Historical spikes of $5k-$6k drive strict controls. */
export interface UsageRecord {
  id: string;
  date: string;
  modelId: string;
  aiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface BudgetStatus {
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  softAlertUsd: number;
  hardAlertUsd: number;
  currentDailyCostUsd: number;
  currentMonthlyCostUsd: number;
  state: 'OK' | 'APPROACHING' | 'OVER';
}

/** Audit trail (Epic 11), precursor to CloudTrail integration. */
export const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'ALERT_VIEWED',
  'ALERT_ACKNOWLEDGED',
  'CONFIG_CHANGED',
  'INTEGRATION_UPDATED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  target: string | null;
  metadata: Record<string, unknown> | null;
}

export const dashboardSummarySchema = z.object({
  totalServices: z.number(),
  activeAlerts: z.number(),
  criticalAlerts: z.number(),
  recentIncidents: z.number(),
  aiAnalyses: z.number(),
  systemHealth: z.enum(['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN']),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export { SEVERITIES, ALERT_STATUSES };
