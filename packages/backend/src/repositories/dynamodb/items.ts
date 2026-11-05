import type {
  AlertStatus,
  AuditAction,
  AuditEvent,
  AuditResult,
  DataSource,
  LogEntry,
  MetricSnapshot,
  PersistedAlert,
  ServiceSummary,
  Theme,
  UrbaniIncidentAlert,
  UsageRecord,
} from '@urbani/shared';
import { PersistenceError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type {
  AIAnalysisRecord,
  AuditEventRecord,
  ChatFeedback,
  ChatMessage,
  ChatSession,
  EnvironmentRecord,
  IntegrationRow,
  RoleRow,
  ServiceInput,
  UserPreferences,
  UserRow,
} from '../types';
import {
  alertGsi1,
  alertKey,
  alertLinkPk,
  analysisGsi1Sk,
  analysisKey,
  auditGsi1,
  auditKey,
  chatFeedbackKey,
  chatMessageKey,
  chatSessionGsi1,
  chatSessionKey,
  environmentKey,
  fitsKey,
  fitsPartitionKey,
  fitsSortKey,
  integrationKey,
  logGsi1Sk,
  logKey,
  metricGsi1Sk,
  metricKey,
  prefsKey,
  roleKey,
  serviceKey,
  usageKey,
  userEmailKey,
  userKey,
} from './keys';

/**
 * Item builders and item-to-record mappers of the DynamoDB driver (design §5.2, §5.4, §5.8).
 *
 * Every PutItem, transactional Put and batch PutRequest builds its item here. Each builder sets
 * `entityType` and checks every key attribute (PK, SK, GSI1PK, GSI1SK) before any call. Each mapper
 * emits exactly the keys of the SQLite mapper for that entity, with null where an attribute is
 * absent or NULL, so both drivers return the same JSON keys.
 */

/** An item as written. */
export type DynamoItem = Record<string, unknown>;
/** An item as read back (unmarshalled). */
export type StoredItem = Record<string, any>;

interface KeyAttributes {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
}

/** Cumulative UTF-8 budget for an alert's evidence lines. */
export const EVIDENCE_BUDGET_BYTES = 256 * 1024;
/** Estimated-size cap below DynamoDB's 400 KB item limit. */
export const ITEM_SIZE_LIMIT_BYTES = 380 * 1024;

/** [F34]: every key attribute must hold 1..2,048 (partition) or 1..1,024 (sort) UTF-8 bytes. */
export function assertKeyFits(key: KeyAttributes): void {
  const fits =
    fitsKey(key.PK, key.SK) &&
    (key.GSI1PK === undefined || fitsPartitionKey(key.GSI1PK)) &&
    (key.GSI1SK === undefined || fitsSortKey(key.GSI1SK));
  if (!fits) throw new PersistenceError('INVALID_ARGUMENT', 'Invalid argument');
}

/** Size guard (§5.8). The estimate, Buffer.byteLength(JSON.stringify(item)), over-estimates the real size. */
export function assertItemSize(item: DynamoItem): void {
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') > ITEM_SIZE_LIMIT_BYTES) {
    throw new PersistenceError('ITEM_TOO_LARGE', 'Item too large');
  }
}

function finish<T extends DynamoItem & KeyAttributes>(item: T): T {
  assertKeyFits(item);
  assertItemSize(item);
  return item;
}

/**
 * Keeps evidence lines in order while their cumulative UTF-8 size is at most EVIDENCE_BUDGET_BYTES.
 * Drops the first line that would exceed the budget and every line after it; never edits text.
 */
export function budgetEvidence(lines: string[], alertId: string): string[] {
  let used = 0;
  let kept = 0;
  for (const line of lines) {
    used += Buffer.byteLength(line, 'utf8');
    if (used > EVIDENCE_BUDGET_BYTES) break;
    kept++;
  }
  if (kept === lines.length) return lines;
  logger.warn('Alert evidence trimmed to fit DynamoDB item limit', {
    alertId,
    keptLines: kept,
    droppedLines: lines.length - kept,
  });
  return lines.slice(0, kept);
}

// ---------------------------------------------------------------- Builders (16)

export function roleItem(row: RoleRow): DynamoItem {
  return finish({
    ...roleKey(row.id),
    entityType: 'ROLE',
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions,
    createdAt: row.created_at,
  });
}

/** isActive is written as row.is_active === 1, because SQLite treats only 1 as active. */
export function userItem(row: UserRow): DynamoItem {
  return finish({
    ...userKey(row.id),
    entityType: 'USER',
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    roleId: row.role_id,
    role: row.role,
    isActive: row.is_active === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  });
}

/** The unique-email lock: { PK: 'USER_EMAIL', SK: email, entityType: 'USER_EMAIL', userId }. */
export function emailLockItem(email: string, userId: string): DynamoItem {
  return finish({ ...userEmailKey(email), entityType: 'USER_EMAIL', userId });
}

export interface PreferencesItemInput {
  userId: string;
  theme: Theme | null;
  widgetLayoutJson: string | null;
  updatedAt: string;
}

export function preferencesItem(p: PreferencesItemInput): DynamoItem {
  return finish({
    ...prefsKey(p.userId),
    entityType: 'PREFS',
    userId: p.userId,
    theme: p.theme,
    widgetLayoutJson: p.widgetLayoutJson,
    updatedAt: p.updatedAt,
  });
}

export interface AuditItemInput {
  id: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  target: string | null;
  /** JSON string or null, as in SQLite. */
  metadataJson: string | null;
  result: AuditResult;
  createdAt: string;
}

export function auditItem(e: AuditItemInput): DynamoItem {
  return finish({
    ...auditKey(e.timestamp, e.id),
    ...auditGsi1(e.actor, e.timestamp, e.id),
    entityType: 'AUDIT',
    id: e.id,
    timestamp: e.timestamp,
    actor: e.actor,
    action: e.action,
    target: e.target,
    metadata: e.metadataJson,
    result: e.result,
    createdAt: e.createdAt,
  });
}

/**
 * Maps every UrbaniIncidentAlert field explicitly (a null confidence is written as NULL), so an
 * update generated from this item overwrites every attribute as SQLite's REPLACE does. The evidence
 * budget applies.
 */
export function alertItem(
  alert: UrbaniIncidentAlert,
  source: DataSource,
  status: AlertStatus,
  createdAt: string,
  ack: { acknowledgedBy: string | null; acknowledgedAt: string | null } = { acknowledgedBy: null, acknowledgedAt: null },
): DynamoItem {
  return finish({
    ...alertKey(alert.alertId),
    ...alertGsi1(source, alert.alertId),
    entityType: 'ALERT',
    alertId: alert.alertId,
    timestamp: alert.timestamp,
    service: alert.service,
    environment: alert.environment,
    severity: alert.severity,
    anomalyType: alert.anomalyType,
    summary: alert.summary,
    evidence: budgetEvidence(alert.evidence, alert.alertId),
    probableCause: alert.probableCause,
    recommendedActions: alert.recommendedActions,
    confidence: alert.confidence,
    modelId: alert.modelId,
    status,
    acknowledgedBy: ack.acknowledgedBy,
    acknowledgedAt: ack.acknowledgedAt,
    dataSource: source,
    createdAt,
  });
}

export function serviceItem(s: ServiceInput, source: DataSource, createdAt: string): DynamoItem {
  return finish({
    ...serviceKey(s.id),
    entityType: 'SERVICE',
    id: s.id,
    name: s.name,
    environment: s.environment,
    status: s.status,
    errorRate: s.errorRate,
    lastTelemetryAt: s.lastTelemetryAt,
    lastIncidentAt: s.lastIncidentAt,
    dataSource: source,
    createdAt,
  });
}

export function environmentItem(env: { id: string; name: string }, createdAt: string): DynamoItem {
  return finish({ ...environmentKey(env.id), entityType: 'ENVIRONMENT', id: env.id, name: env.name, createdAt });
}

/** GSI1SK is always present; GSI1PK (ALERTLINK#) and alertId only while linked. */
export function logItem(log: LogEntry, source: DataSource, alertId: string | null = null): DynamoItem {
  return finish({
    ...logKey(log.id),
    ...(alertId !== null ? { GSI1PK: alertLinkPk(alertId) } : {}),
    GSI1SK: logGsi1Sk(log.timestamp, log.id),
    entityType: 'LOG',
    id: log.id,
    timestamp: log.timestamp,
    level: log.level,
    service: log.service,
    environment: log.environment,
    message: log.message,
    dataSource: source,
    ...(alertId !== null ? { alertId } : {}),
  });
}

/** GSI1SK is always present; GSI1PK (ALERTLINK#) and alertId only while linked. */
export function metricItem(m: MetricSnapshot, source: DataSource, alertId: string | null = null): DynamoItem {
  return finish({
    ...metricKey(m.id),
    ...(alertId !== null ? { GSI1PK: alertLinkPk(alertId) } : {}),
    GSI1SK: metricGsi1Sk(m.timestamp, m.id),
    entityType: 'METRIC',
    id: m.id,
    service: m.service,
    environment: m.environment,
    timestamp: m.timestamp,
    cpuPercent: m.cpuPercent,
    memoryPercent: m.memoryPercent,
    errorRate: m.errorRate,
    requestCount: m.requestCount,
    latencyMsP95: m.latencyMsP95,
    http5xxCount: m.http5xxCount,
    instanceRestarts: m.instanceRestarts,
    dataSource: source,
    ...(alertId !== null ? { alertId } : {}),
  });
}

export function usageItem(u: UsageRecord, source: DataSource): DynamoItem {
  return finish({
    ...usageKey(u.date, u.modelId),
    entityType: 'USAGE',
    id: u.id,
    date: u.date,
    modelId: u.modelId,
    aiRequestCount: u.aiRequestCount,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    estimatedCostUsd: u.estimatedCostUsd,
    dataSource: source,
  });
}

/** findingJson is JSON.stringify(finding), so a null finding round-trips as the string 'null', as in SQLite. */
export function analysisItem(rec: AIAnalysisRecord, createdAt: string): DynamoItem {
  const linked = rec.alertId != null;
  return finish({
    ...analysisKey(rec.id),
    ...(linked ? { GSI1PK: alertLinkPk(rec.alertId as string) } : {}),
    GSI1SK: analysisGsi1Sk(rec.timestamp, rec.id),
    entityType: 'AI_ANALYSIS',
    id: rec.id,
    ...(linked ? { alertId: rec.alertId } : {}),
    timestamp: rec.timestamp,
    service: rec.service,
    environment: rec.environment,
    modelId: rec.modelId,
    provider: rec.provider,
    anomalyType: rec.anomalyType,
    confidence: rec.confidence,
    findingJson: JSON.stringify(rec.finding),
    inputTokens: rec.inputTokens,
    outputTokens: rec.outputTokens,
    dataSource: rec.dataSource,
    createdAt,
  });
}

export function integrationItem(row: IntegrationRow): DynamoItem {
  return finish({
    ...integrationKey(row.id),
    entityType: 'INTEGRATION',
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    mode: row.mode,
    status: row.status,
    configJson: row.config_json,
    updatedAt: row.updated_at,
  });
}

export function chatSessionItem(s: ChatSession): DynamoItem {
  return finish({
    ...chatSessionKey(s.id),
    ...chatSessionGsi1(s.userId, s.updatedAt, s.id),
    entityType: 'CHAT_SESSION',
    id: s.id,
    userId: s.userId,
    title: s.title,
    service: s.service,
    environment: s.environment,
    messageCount: s.messageCount,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  });
}

export function chatMessageItem(m: ChatMessage): DynamoItem {
  return finish({
    ...chatMessageKey(m.sessionId, m.id),
    entityType: 'CHAT_MESSAGE',
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    citations: m.citations,
    provider: m.provider,
    modelId: m.modelId,
    source: m.source,
    latencyMs: m.latencyMs,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    createdAt: m.createdAt,
  });
}

export function feedbackItem(f: ChatFeedback): DynamoItem {
  return finish({
    ...chatFeedbackKey(f.sessionId, f.messageId),
    entityType: 'CHAT_FEEDBACK',
    messageId: f.messageId,
    sessionId: f.sessionId,
    userId: f.userId,
    rating: f.rating,
    comment: f.comment,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  });
}

// ---------------------------------------------------------------- Mappers (same keys as SQLite)

export function itemToRole(item: StoredItem): RoleRow {
  return {
    id: item.id,
    name: item.name,
    description: item.description ?? null,
    permissions: item.permissions,
    created_at: item.createdAt,
  };
}

/** Rebuilt in snake_case; is_active is 1 or 0. */
export function itemToUser(item: StoredItem): UserRow {
  return {
    id: item.id,
    email: item.email,
    display_name: item.displayName,
    password_hash: item.passwordHash,
    role_id: item.roleId,
    is_active: item.isActive ? 1 : 0,
    last_login_at: item.lastLoginAt ?? null,
    created_at: item.createdAt,
    role: item.role,
  };
}

export function itemToPreferences(item: StoredItem): UserPreferences {
  return {
    userId: item.userId,
    theme: (item.theme ?? null) as Theme | null,
    widgetLayout: item.widgetLayoutJson == null ? null : (JSON.parse(item.widgetLayoutJson) as unknown),
    updatedAt: item.updatedAt,
  };
}

/** Legacy audit shape: exactly the AuditEvent keys, no `result`. */
export function itemToAuditEvent(item: StoredItem): AuditEvent {
  return {
    id: item.id,
    timestamp: item.timestamp,
    actor: item.actor,
    action: item.action as AuditAction,
    target: item.target ?? null,
    metadata: item.metadata ? (JSON.parse(item.metadata) as Record<string, unknown>) : null,
  };
}

export function itemToAuditRecord(item: StoredItem): AuditEventRecord {
  return { ...itemToAuditEvent(item), result: item.result as AuditResult };
}

/** Ids of the logs and metrics linked to an alert (the ALERTLINK# partition). */
export interface AlertLinks {
  logIds: string[];
  metricIds: string[];
}

export function itemToAlert(item: StoredItem, links: AlertLinks): PersistedAlert {
  return {
    alertId: item.alertId,
    timestamp: item.timestamp,
    service: item.service,
    environment: item.environment,
    severity: item.severity as PersistedAlert['severity'],
    anomalyType: item.anomalyType,
    summary: item.summary,
    evidence: item.evidence ?? [],
    probableCause: item.probableCause,
    recommendedActions: item.recommendedActions ?? [],
    confidence: item.confidence ?? null,
    modelId: item.modelId,
    status: item.status as AlertStatus,
    acknowledgedBy: item.acknowledgedBy ?? null,
    acknowledgedAt: item.acknowledgedAt ?? null,
    relatedLogIds: links.logIds,
    relatedMetricIds: links.metricIds,
  };
}

export function itemToService(item: StoredItem, alertCount: number): ServiceSummary {
  return {
    id: item.id,
    name: item.name,
    environment: item.environment,
    status: item.status as ServiceSummary['status'],
    errorRate: item.errorRate,
    lastTelemetryAt: item.lastTelemetryAt ?? null,
    lastIncidentAt: item.lastIncidentAt ?? null,
    alertCount,
  };
}

export function itemToEnvironment(item: StoredItem): EnvironmentRecord {
  return { id: item.id, name: item.name, createdAt: item.createdAt };
}

export function itemToLog(item: StoredItem): LogEntry {
  return {
    id: item.id,
    timestamp: item.timestamp,
    level: item.level as LogEntry['level'],
    service: item.service,
    environment: item.environment,
    message: item.message,
  };
}

export function itemToMetric(item: StoredItem): MetricSnapshot {
  return {
    id: item.id,
    service: item.service,
    environment: item.environment,
    timestamp: item.timestamp,
    cpuPercent: item.cpuPercent,
    memoryPercent: item.memoryPercent,
    errorRate: item.errorRate,
    requestCount: item.requestCount,
    latencyMsP95: item.latencyMsP95,
    http5xxCount: item.http5xxCount,
    instanceRestarts: item.instanceRestarts,
  };
}

export function itemToUsage(item: StoredItem): UsageRecord {
  return {
    id: item.id,
    date: item.date,
    modelId: item.modelId,
    aiRequestCount: item.aiRequestCount,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    estimatedCostUsd: item.estimatedCostUsd,
  };
}

export function itemToAnalysis(item: StoredItem): AIAnalysisRecord {
  return {
    id: item.id,
    alertId: item.alertId ?? null,
    timestamp: item.timestamp,
    service: item.service,
    environment: item.environment,
    modelId: item.modelId,
    provider: item.provider,
    anomalyType: item.anomalyType ?? null,
    confidence: item.confidence ?? null,
    finding: item.findingJson ? (JSON.parse(item.findingJson) as UrbaniIncidentAlert) : null,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    dataSource: item.dataSource as DataSource,
  };
}

export function itemToIntegration(item: StoredItem): IntegrationRow {
  return {
    id: item.id,
    kind: item.kind,
    display_name: item.displayName,
    mode: item.mode,
    status: item.status,
    config_json: item.configJson,
    updated_at: item.updatedAt,
  };
}

export function itemToChatSession(item: StoredItem): ChatSession {
  return {
    id: item.id,
    userId: item.userId,
    title: item.title ?? null,
    service: item.service ?? null,
    environment: item.environment ?? null,
    messageCount: item.messageCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function itemToChatMessage(item: StoredItem): ChatMessage {
  return {
    id: item.id,
    sessionId: item.sessionId,
    role: item.role as ChatMessage['role'],
    content: item.content,
    citations: item.citations ?? [],
    provider: item.provider ?? null,
    modelId: item.modelId ?? null,
    source: (item.source ?? null) as DataSource | null,
    latencyMs: item.latencyMs ?? null,
    inputTokens: item.inputTokens ?? null,
    outputTokens: item.outputTokens ?? null,
    createdAt: item.createdAt,
  };
}

export function itemToFeedback(item: StoredItem): ChatFeedback {
  return {
    messageId: item.messageId,
    sessionId: item.sessionId,
    userId: item.userId,
    rating: item.rating as ChatFeedback['rating'],
    comment: item.comment ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
