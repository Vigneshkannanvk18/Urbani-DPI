import type {
  NotificationChannelName, NotificationLogEntry, NotificationRule, NotificationSettings, NotificationStatus,
  AlertStatus, AuditAction, AuditEvent, AuditResult, ChatMessageRole, ChatRating, DataSource,
  LogEntry, MetricSnapshot, PersistedAlert, ServiceSummary, Theme, UrbaniIncidentAlert,
  UsageRecord, UserRole,
} from '@urbani/shared';

export type DbDriver = 'sqlite' | 'dynamodb';
/** Legacy offset-paged result; total counts every match. */
export interface PageResult<T> { items: T[]; total: number }
/** DPI 2 cursor page; nextCursor is null exactly when there are no further items. */
export interface CursorPage<T> { items: T[]; nextCursor: string | null }
export interface CursorOptions { limit?: number; cursor?: string }
/** now() supplies every repository-generated timestamp (ISO-8601 UTC, ms). Default: new Date().toISOString(). */
export interface RepositoryOptions { now?: () => string }

// ---- Alerts ----
export interface AlertFilter {
  service?: string; environment?: string; severity?: string; anomalyType?: string; status?: string;
  search?: string; from?: string; to?: string; page?: number; pageSize?: number;
  /** Item 6: restrict to one provenance (the notifier only sends LIVE, or MOCK for demos). */
  dataSource?: DataSource;
}
export interface AlertRepository {
  /** Full replace (REPLACE semantics, §2.5-1). Defaults: source 'MOCK', status 'OPEN'. */
  insert(alert: UrbaniIncidentAlert, source?: DataSource, status?: AlertStatus): Promise<void>;
  /** Body refreshed and dataSource set to LIVE; status/acknowledgedBy/acknowledgedAt preserved; new rows are OPEN. */
  upsertLivePreservingStatus(alert: UrbaniIncidentAlert): Promise<void>;
  findById(alertId: string): Promise<PersistedAlert | null>;
  query(filter: AlertFilter): Promise<PageResult<PersistedAlert>>;
  replaceDerivedEvidence(alertId: string, lines: string[]): Promise<void>;
  deleteByDataSource(source: DataSource): Promise<number>;
  acknowledge(alertId: string, actor: string): Promise<PersistedAlert | null>;
  /** New: same value as query({}).total, without loading children (dashboard). */
  countAll(): Promise<number>;
  countActive(): Promise<number>;
  countBySeverity(severity: string): Promise<number>;
}

// ---- Services, environments ----
export type ServiceInput = Pick<ServiceSummary,
  'id' | 'name' | 'environment' | 'status' | 'errorRate' | 'lastTelemetryAt' | 'lastIncidentAt'>;
export interface ServiceRepository {
  all(): Promise<ServiceSummary[]>;                      // ORDER BY name; alertCount computed
  findById(id: string): Promise<ServiceSummary | null>;
  count(): Promise<number>;
  upsert(service: ServiceInput, source: DataSource): Promise<void>;   // new (seed): INSERT OR REPLACE
}
export interface EnvironmentRecord { id: string; name: string; createdAt: string }
export interface EnvironmentRepository {
  ensure(env: { id: string; name: string }): Promise<void>;           // new (seed): INSERT OR IGNORE
  all(): Promise<EnvironmentRecord[]>;                                // ORDER BY name
}

// ---- Logs, metrics, usage ----
export interface LogFilter {
  service?: string; environment?: string; level?: string; search?: string; page?: number; pageSize?: number;
}
export interface LogRepository {
  query(filter: LogFilter): Promise<PageResult<LogEntry>>;
  byAlert(alertId: string): Promise<LogEntry[]>;
  clearAlertLinks(alertId: string): Promise<void>;
  linkLogsToAlert(alertId: string, logIds: string[]): Promise<void>;
  upsertMany(logs: LogEntry[], source: DataSource): Promise<void>;   // new (seed): INSERT OR REPLACE, clears link
}
export interface MetricFilter { service?: string; environment?: string; limit?: number }
export interface MetricRepository {
  query(filter: MetricFilter): Promise<MetricSnapshot[]>;
  upsertMany(metrics: MetricSnapshot[], source: DataSource): Promise<void>;   // new (seed)
}
export interface UsageRepository {
  all(): Promise<UsageRecord[]>;                                       // ORDER BY date DESC
  upsertMany(records: UsageRecord[], source: DataSource): Promise<void>;   // new (seed)
}

// ---- AI analyses ----
export interface AIAnalysisRecord {
  id: string; alertId: string | null; timestamp: string; service: string; environment: string;
  modelId: string; provider: string; anomalyType: string | null; confidence: number | null;
  finding: UrbaniIncidentAlert | null; inputTokens: number; outputTokens: number; dataSource: DataSource;
}
export type NewAIAnalysis = Omit<AIAnalysisRecord, 'id'> & { id?: string };
export interface AIAnalysisRepository {
  insert(rec: NewAIAnalysis): Promise<string>;
  query(opts: { page?: number; pageSize?: number }): Promise<PageResult<AIAnalysisRecord>>;
  findById(id: string): Promise<AIAnalysisRecord | null>;
  count(): Promise<number>;
}

// ---- Audit ----
export interface AuditEventRecord extends AuditEvent { result: AuditResult }
export interface AuditQuery { action?: string; actor?: string; page?: number; pageSize?: number }
export interface AuditRangeQuery extends CursorOptions {
  from?: string; to?: string; actor?: string;
  /** Item 3 filters: action IN (...), exact result, case-insensitive text on target + metadata JSON, case-sensitive metadata substring. */
  actions?: string[]; result?: AuditResult; text?: string; metadataContains?: string;
}
export interface AuditRepository {
  /** result defaults to 'SUCCESS'. */
  record(actor: string, action: AuditAction, target?: string,
         metadata?: Record<string, unknown>, result?: AuditResult): Promise<void>;
  /** Legacy (GET /api/audit). Items are exactly AuditEvent: no `result` key (API shape parity). */
  query(opts: AuditQuery): Promise<PageResult<AuditEvent>>;
  /** New (item 3): newest first, inclusive bounds, optional actor (= by user). limit 1..200, default 50. */
  listByTimeRange(opts: AuditRangeQuery): Promise<CursorPage<AuditEventRecord>>;
  /** Retention (item 3): deletes events with timestamp < cutoff (ISO). Returns the number deleted. The only delete. */
  purgeOlderThan(cutoff: string): Promise<number>;
}

// ---- Integrations ----
export interface IntegrationRow {
  id: string; kind: string; display_name: string; mode: string; status: string; config_json: string; updated_at: string;
}
export interface IntegrationRepository {
  all(): Promise<IntegrationRow[]>;          // ORDER BY kind
  upsert(row: IntegrationRow): Promise<void>; // new (seed): INSERT OR REPLACE
  delete(id: string): Promise<void>;          // new (seed): replaces the raw stale-row DELETE
}

// ---- Users, roles ----
export interface RoleRow { id: string; name: string; description: string | null; permissions: string; created_at: string }
export interface UserRow {
  id: string; email: string; display_name: string; password_hash: string; role_id: string;
  is_active: number; last_login_at: string | null; created_at: string;
  /** DPI 2 RBAC role. Stored only; AuthUser.role and the JWT still come from role_id → roles.name (item 2 decides the switch). */
  role: UserRole;
}
/** role omitted: new user → SUPER_ADMIN; existing user → stored role kept. */
export type UserUpsert = Omit<UserRow, 'role'> & { role?: UserRole };
export interface AuthUser { id: string; email: string; displayName: string; role: string; permissions: string[] }
/** DPI 2 item 5: authentication state kept beside (not inside) UserRow. Secrets are stored encrypted / hashed only. */
export type AuthSource = 'local' | 'sso';
export interface UserSecurity {
  authSource: AuthSource;
  mfaEnabled: boolean;
  /** AES-256-GCM envelope; decrypted only by the MFA service. */
  mfaSecretEncrypted: string | null;
  mfaEnrolledAt: string | null;
  /** SHA-256 hex hashes of unused recovery codes. */
  mfaRecoveryHashes: string[];
  /** Last accepted TOTP time-step (replay protection). */
  mfaLastStep: number | null;
  mfaFailedCount: number;
  mfaLockedUntil: string | null;
}
export const DEFAULT_USER_SECURITY: UserSecurity = {
  authSource: 'local', mfaEnabled: false, mfaSecretEncrypted: null, mfaEnrolledAt: null,
  mfaRecoveryHashes: [], mfaLastStep: null, mfaFailedCount: 0, mfaLockedUntil: null,
};
export interface UserRepository {
  /** Item 5: defaults for a missing user. */
  getSecurity(id: string): Promise<UserSecurity>;
  /** Item 5: security state for every user, keyed by user id. */
  listSecurity(): Promise<Record<string, UserSecurity>>;
  /** Item 5: partial update; a missing user is a no-op. */
  updateSecurity(id: string, patch: Partial<UserSecurity>): Promise<void>;
  /** Item 5: atomically accepts a TOTP step only if it is newer than the last accepted one. */
  claimTotpStep(id: string, step: number): Promise<boolean>;
  /** Item 5: atomically removes one recovery hash; false if it was not present (already used). */
  consumeRecoveryHash(id: string, hash: string): Promise<boolean>;
  findByEmail(email: string): Promise<UserRow | null>;
  findById(id: string): Promise<UserRow | null>;
  /** Item 2: includes inactive users (findBy* return active users only). */
  getById(id: string): Promise<UserRow | null>;
  /** Item 2: all users, active and inactive, ordered by email. */
  list(): Promise<UserRow[]>;
  getRole(roleId: string): Promise<RoleRow | null>;
  toAuthUser(user: UserRow): Promise<AuthUser>;
  recordLogin(id: string): Promise<void>;
  upsertRole(row: RoleRow): Promise<void>;
  upsertUser(row: UserUpsert): Promise<void>;
}

// ---- Preferences ----
export interface UserPreferences { userId: string; theme: Theme | null; widgetLayout: unknown; updatedAt: string } // widgetLayout null = unset
export interface PreferencesPatch { theme?: Theme | null; widgetLayout?: unknown }   // undefined = keep, null = clear
export interface PreferencesRepository {
  get(userId: string): Promise<UserPreferences | null>;
  update(userId: string, patch: PreferencesPatch): Promise<UserPreferences>;
}

// ---- Chat ----
export interface ChatSession {
  id: string; userId: string; title: string | null; service: string | null; environment: string | null;
  messageCount: number; createdAt: string; updatedAt: string;
}
export interface ChatMessage {
  id: string; sessionId: string; role: ChatMessageRole; content: string; citations: string[];
  provider: string | null; modelId: string | null; source: DataSource | null; latencyMs: number | null;
  inputTokens: number | null; outputTokens: number | null; createdAt: string;
}
export interface ChatFeedback {
  messageId: string; sessionId: string; userId: string; rating: ChatRating; comment: string | null;
  createdAt: string; updatedAt: string;
}
export interface NewChatSession { id?: string; userId: string; title?: string | null; service?: string | null; environment?: string | null }
export interface NewChatMessage {
  sessionId: string; role: ChatMessageRole; content: string; citations?: string[]; provider?: string | null;
  modelId?: string | null; source?: DataSource | null; latencyMs?: number | null;
  inputTokens?: number | null; outputTokens?: number | null;
}
export interface ChatFeedbackInput { sessionId: string; messageId: string; userId: string; rating: ChatRating; comment?: string | null }
export interface ChatRepository {
  createSession(input: NewChatSession): Promise<ChatSession>;
  getSession(sessionId: string): Promise<ChatSession | null>;
  /** Most recent activity first; limit 1..100, default 20. */
  listSessionsByUser(userId: string, opts?: CursorOptions): Promise<CursorPage<ChatSession>>;
  /** Message id is repository-generated and time-ordered (§4.5). */
  appendMessage(input: NewChatMessage): Promise<ChatMessage>;
  /** Oldest first; limit 1..500, default 200. */
  listMessages(sessionId: string, opts?: CursorOptions): Promise<CursorPage<ChatMessage>>;
  /** One feedback per message; create or update. */
  setFeedback(input: ChatFeedbackInput): Promise<ChatFeedback>;
  listFeedback(sessionId: string): Promise<ChatFeedback[]>;   // ordered by messageId
}

// ---- Notifications (DPI 2 item 6) ----
export type NewNotificationRule = Omit<NotificationRule, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'> & { id?: string };
export type NotificationRulePatch = Partial<Pick<NotificationRule,
  'name' | 'enabled' | 'minSeverity' | 'services' | 'anomalyTypes' | 'channels'>>;
export interface NotificationSettingsPatch {
  dedupWindowMinutes?: number; maxPerHourPerChannel?: number; defaultRuleSeeded?: boolean;
}
export interface NotificationSettingsRecord extends NotificationSettings {
  /** Watermark: the instant the engine first ran. Alerts older than this (and older than the max age) are never notified. */
  engineEnabledAt: string | null;
  defaultRuleSeeded: boolean;
}
export type NewNotificationLog = Omit<NotificationLogEntry, 'id' | 'timestamp'>;
export interface NotificationLogQuery {
  channel?: NotificationChannelName; status?: NotificationStatus; alertId?: string;
  from?: string; to?: string; page?: number; pageSize?: number;
}
export interface NotificationRepository {
  listRules(): Promise<NotificationRule[]>;
  getRule(id: string): Promise<NotificationRule | null>;
  /** An explicit id that already exists raises DUPLICATE. */
  createRule(input: NewNotificationRule): Promise<NotificationRule>;
  updateRule(id: string, patch: NotificationRulePatch, actor: string): Promise<NotificationRule | null>;
  deleteRule(id: string): Promise<boolean>;
  getSettings(): Promise<NotificationSettingsRecord>;
  updateSettings(patch: NotificationSettingsPatch, actor: string): Promise<NotificationSettingsRecord>;
  /** Sets the watermark only if unset; returns the effective value (atomic). */
  setEngineEnabledAtIfUnset(iso: string): Promise<string>;
  /**
   * Atomic conditional claim of (dedupKey, channel). Succeeds (true) only when no claim exists or the existing one
   * is older than `windowMs`. windowMs = null means the claim is permanent. Exactly one concurrent caller wins.
   */
  claim(dedupKey: string, channel: NotificationChannelName, windowMs: number | null): Promise<boolean>;
  appendLog(entry: NewNotificationLog): Promise<NotificationLogEntry>;
  /** Newest first. */
  listLog(q: NotificationLogQuery): Promise<PageResult<NotificationLogEntry>>;
  /** Non-test deliveries that were attempted (SENT, FAILED, DRY_RUN) on the channel since `sinceIso`. */
  countDeliveries(channel: NotificationChannelName, sinceIso: string): Promise<number>;
  /** Retention: deletes log entries and claims older than the cutoff. Returns the number of log entries deleted. */
  purgeOlderThan(cutoff: string): Promise<number>;
}

// ---- Health ----
export interface HealthRepository { ping(): Promise<void> }

export interface Repositories {
  readonly driver: DbDriver;
  alerts: AlertRepository; services: ServiceRepository; environments: EnvironmentRepository;
  logs: LogRepository; metrics: MetricRepository; usage: UsageRepository; aiAnalyses: AIAnalysisRepository;
  audit: AuditRepository; integrations: IntegrationRepository; users: UserRepository;
  preferences: PreferencesRepository; chat: ChatRepository; health: HealthRepository;
  notifications: NotificationRepository;
  /** SQLite: closeDb(); DynamoDB: client.destroy(). Used by CLIs and tests. */
  close(): Promise<void>;
}
