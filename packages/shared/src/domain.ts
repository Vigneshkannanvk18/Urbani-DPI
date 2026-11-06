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
  'auth.login_failed',
  'access.denied',
  'user.create',
  'user.role_change',
  'user.activate',
  'user.deactivate',
  'user.password_reset',
  'chat.query',
  'logs.search',
  'ai.analyze',
  'audit.view',
  'audit.purge',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Audit classification (DPI 2 item 3). The ONE place that lists audited actions.
 * CONFIG = changes system state. SENSITIVE_QUERY = read of sensitive data, plus access/auth events.
 * DRAFT: the client confirms which actions it considers sensitive (see docs/AUDIT.md).
 */
export const AUDIT_CATEGORIES = ['CONFIG', 'SENSITIVE_QUERY'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export const AUDIT_ACTION_CATALOG: Record<AuditAction, { category: AuditCategory; description: string }> = {
  LOGIN: { category: 'SENSITIVE_QUERY', description: 'Successful sign-in' },
  LOGOUT: { category: 'SENSITIVE_QUERY', description: 'Sign-out' },
  'auth.login_failed': { category: 'SENSITIVE_QUERY', description: 'Failed sign-in attempt' },
  'access.denied': { category: 'SENSITIVE_QUERY', description: 'Request refused by the permission check' },
  ALERT_VIEWED: { category: 'SENSITIVE_QUERY', description: 'Alert detail viewed' },
  ALERT_ACKNOWLEDGED: { category: 'CONFIG', description: 'Alert acknowledged' },
  CONFIG_CHANGED: { category: 'CONFIG', description: 'Settings update requested' },
  INTEGRATION_UPDATED: { category: 'CONFIG', description: 'Integration status changed' },
  'user.create': { category: 'CONFIG', description: 'User created' },
  'user.role_change': { category: 'CONFIG', description: 'User role changed' },
  'user.activate': { category: 'CONFIG', description: 'User activated' },
  'user.deactivate': { category: 'CONFIG', description: 'User deactivated' },
  'user.password_reset': { category: 'CONFIG', description: 'User password reset' },
  'ai.analyze': { category: 'CONFIG', description: 'AI analysis triggered' },
  'audit.purge': { category: 'CONFIG', description: 'Retention purge of old audit events' },
  'chat.query': { category: 'SENSITIVE_QUERY', description: 'Assistant question asked (preview only, no answer)' },
  'logs.search': { category: 'SENSITIVE_QUERY', description: 'Log search or filter performed (parameters only)' },
  'audit.view': { category: 'SENSITIVE_QUERY', description: 'Audit log viewed or searched' },
};
export const auditActionsForCategory = (c: AuditCategory): AuditAction[] =>
  AUDIT_ACTIONS.filter((a) => AUDIT_ACTION_CATALOG[a].category === c);

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  target: string | null;
  metadata: Record<string, unknown> | null;
}

/** DPI 2 persistence vocabularies (item 1). Later items show these in the UI. */
export const USER_ROLES = ['SUPER_ADMIN', 'INFRA_ADMIN', 'QA_OPERATOR', 'READER_AUDITOR'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const AUDIT_RESULTS = ['SUCCESS', 'FAILURE', 'DENIED'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const CHAT_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];
export const CHAT_RATINGS = ['LIKE', 'DISLIKE'] as const;
export type ChatRating = (typeof CHAT_RATINGS)[number];

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
