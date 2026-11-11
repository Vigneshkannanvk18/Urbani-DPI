import type {
  Sourced,
  Paginated,
  PersistedAlert,
  DashboardSummary,
  LogEntry,
  LogSearchMeta,
  MetricSnapshot,
  ServiceSummary,
  UsageRecord,
  BudgetStatus,
  AuditEvent,
  UserRole,
  ThemePreference,
  HealthStatusResponse,
  HealthHistoryResponse,
  HealthRange,
} from '@urbani/shared';
import { api, setToken, clearToken } from './client';

/** Typed wrappers around each documented API endpoint. */

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  /** RBAC role (DPI 2 item 2) and display name. `permissions` is the effective list. */
  rbacRole: UserRole;
  rbacRoleName: string;
  permissions: string[];
}

/** Result of the password step (DPI 2 item 5). */
export type LoginOutcome =
  | { kind: 'session'; user: AuthUser }
  | { kind: 'mfa'; mfaToken: string }
  | { kind: 'enroll'; enrollToken: string; user: AuthUser };

export interface AuthConfig {
  provider: 'local' | 'oidc';
  ssoEnabled: boolean;
  localEnabled: boolean;
  ssoLoginUrl: string | null;
}
export interface MfaStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
  authSource: 'local' | 'sso';
}
export interface MfaEnrolStart {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}
export type MfaCredential = { code: string } | { recoveryCode: string };

export const mfaApi = {
  status: (token?: string) => api.get<MfaStatus>('/auth/mfa/status', { token }),
  start: (token?: string) => api.post<MfaEnrolStart>('/auth/mfa/enroll/start', {}, { token }),
  confirm: (code: string, token?: string) =>
    api.post<{ recoveryCodes: string[]; session?: { token: string; user: AuthUser } }>('/auth/mfa/enroll/confirm', { code }, { token }),
  disable: (password: string, cred: MfaCredential) => api.post<{ ok: true }>('/auth/mfa/disable', { password, ...cred }),
  regenerate: (password: string, cred: MfaCredential) =>
    api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes/regenerate', { password, ...cred }),
};

export const authApi = {
  config: () => api.get<AuthConfig>('/auth/config'),
  async login(email: string, password: string): Promise<LoginOutcome> {
    const res = await api.post<{
      token?: string; user?: AuthUser; mfaRequired?: boolean; mfaToken?: string; mfaEnrollmentRequired?: boolean; enrollToken?: string;
    }>('/auth/login', { email, password });
    if (res.mfaRequired && res.mfaToken) return { kind: 'mfa', mfaToken: res.mfaToken };
    if (res.mfaEnrollmentRequired && res.enrollToken && res.user) return { kind: 'enroll', enrollToken: res.enrollToken, user: res.user };
    setToken(res.token as string);
    return { kind: 'session', user: res.user as AuthUser };
  },
  async verifyMfa(mfaToken: string, cred: MfaCredential): Promise<AuthUser> {
    const res = await api.post<{ token: string; user: AuthUser }>('/auth/mfa/verify', { mfaToken, ...cred });
    setToken(res.token);
    return res.user;
  },
  async logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } finally {
      clearToken();
    }
  },
  me: () => api.get<{ user: AuthUser }>('/auth/me').then((r) => r.user),
};

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  roleName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  mfaEnabled: boolean;
  authSource: 'local' | 'sso';
}

export const usersApi = {
  list: () => api.get<{ data: ManagedUser[] }>('/users').then((r) => r.data),
  create: (u: { email: string; displayName: string; role: UserRole; password?: string }) =>
    api.post<{ data: ManagedUser }>('/users', u).then((r) => r.data),
  changeRole: (id: string, role: UserRole) =>
    api.put<{ data: ManagedUser }>(`/users/${id}/role`, { role }).then((r) => r.data),
  setActive: (id: string, active: boolean) =>
    api.post<{ data: ManagedUser }>(`/users/${id}/${active ? 'activate' : 'deactivate'}`).then((r) => r.data),
  resetPassword: (id: string, password: string) => api.post(`/users/${id}/reset-password`, { password }),
  resetMfa: (id: string) => api.post(`/users/${id}/mfa/reset`),
};

export const dashboardApi = {
  summary: () => api.get<Sourced<DashboardSummary>>('/dashboard/summary'),
  health: () =>
    api.get<Sourced<{ services: ServiceSummary[]; recentMetrics: MetricSnapshot[] }>>(
      '/dashboard/health',
    ),
};

export interface AlertQueryParams {
  service?: string;
  environment?: string;
  severity?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

function qs(params: object): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => [k, String(v)] as [string, string]);
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

export const alertsApi = {
  list: (params: AlertQueryParams = {}) =>
    api.get<Sourced<Paginated<PersistedAlert>>>(`/alerts${qs(params)}`),
  get: (id: string) =>
    api.get<Sourced<PersistedAlert & { relatedLogs: LogEntry[] }>>(`/alerts/${id}`),
  acknowledge: (id: string) => api.post<Sourced<PersistedAlert>>(`/alerts/${id}/acknowledge`),
};

export interface LogQueryParams {
  service?: string;
  level?: string;
  /** Comma-separated levels, e.g. "ERROR,WARN". */
  levels?: string;
  /** Comma-separated servers (services), e.g. "main,payments". */
  services?: string;
  search?: string;
  regex?: boolean;
  /** ISO 8601 date-time. */
  from?: string;
  to?: string;
  sort?: 'newest' | 'oldest';
  page?: number;
  pageSize?: number;
}

export const logsApi = {
  list: (params: LogQueryParams = {}) =>
    api.get<Sourced<Paginated<LogEntry>> & { meta?: LogSearchMeta }>(`/logs${qs(params)}`),
};

export const metricsApi = {
  list: (params: { service?: string; environment?: string } = {}) =>
    api.get<Sourced<MetricSnapshot[]>>(`/metrics${qs(params)}`),
};

export const servicesApi = {
  list: () => api.get<Sourced<ServiceSummary[]>>('/services'),
  get: (id: string) => api.get<Sourced<ServiceSummary>>(`/services/${id}`),
};

export interface AIAnalysis {
  id: string;
  alertId: string | null;
  timestamp: string;
  service: string;
  environment: string;
  modelId: string;
  provider: string;
  anomalyType: string | null;
  confidence: number | null;
  finding: PersistedAlert | null;
  inputTokens: number;
  outputTokens: number;
  dataSource: string;
}

export const aiApi = {
  list: (params: { page?: number } = {}) =>
    api.get<Sourced<Paginated<AIAnalysis>>>(`/ai/analyses${qs(params)}`),
  get: (id: string) => api.get<Sourced<AIAnalysis | null>>(`/ai/analyses/${id}`),
  analyze: (service: string, environment: string) =>
    api.post<Sourced<AIAnalysis>>('/ai/analyze', { service, environment }),
};

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAnswer {
  answer: string;
  citations: string[];
  provider: string;
  modelId: string;
  service: string;
  environment: string;
  logsSource: string;
  /** Honest grounding note (may draw on alerts, not just the filtered log window). */
  groundingNote: string;
  inputTokens: number;
  outputTokens: number;
  /** DPI 2 items 8-9 (additive; absent on older backends). */
  sessionId?: string | null;
  assistantMessageId?: string | null;
  historyEnabled?: boolean;
  latencyMs?: { totalMs: number; providerMs: number } | null;
}
export type ApiRating = 'UP' | 'DOWN';
export interface ChatSessionSummary {
  id: string;
  title: string | null;
  service: string | null;
  environment: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface ChatStoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: string[];
  provider: string | null;
  modelId: string | null;
  source: string | null;
  logsSource: string | null;
  groundingNote: string | null;
  isError: boolean;
  latencyMs: { totalMs: number; providerMs: number | null } | null;
  createdAt: string;
  feedback: { rating: ApiRating; comment: string | null } | null;
}
export interface LatencyStats { count: number; p50: number | null; p95: number | null; max: number | null }
export interface ChatQualitySummary {
  range: { from: string; to: string };
  historyEnabled: boolean;
  feedback: {
    total: number; up: number; down: number; satisfactionPct: number | null;
    perDay: { date: string; up: number; down: number }[];
    perService: { service: string; up: number; down: number }[];
  };
  latency: { totalMs: LatencyStats; providerMs: LatencyStats; note: string };
  recentDownComments: { messageId: string; service: string | null; comment: string; timestamp: string }[];
}
export const chatApi = {
  ask: (
    question: string,
    opts: { service?: string; environment?: string; history?: ChatTurn[]; sessionId?: string } = {},
  ) => api.post<Sourced<ChatAnswer>>('/chat', { question, ...opts }),
  sessions: (cursor?: string) =>
    api.get<{ data: { items: ChatSessionSummary[]; nextCursor: string | null; historyEnabled: boolean } }>(
      `/chat/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  session: (id: string) =>
    api.get<{ data: { session: ChatSessionSummary; messages: ChatStoredMessage[] } }>(`/chat/sessions/${encodeURIComponent(id)}`),
  rename: (id: string, title: string) =>
    api.patch<{ data: ChatSessionSummary }>(`/chat/sessions/${encodeURIComponent(id)}`, { title }),
  remove: (id: string) => api.delete<{ data: { deleted: boolean } }>(`/chat/sessions/${encodeURIComponent(id)}`),
  feedback: (messageId: string, rating: ApiRating | null, comment?: string) =>
    api.put<{ data: { rating: ApiRating | null; comment: string | null } }>(
      `/chat/messages/${encodeURIComponent(messageId)}/feedback`,
      { rating, ...(comment ? { comment } : {}) },
    ),
  summary: () => api.get<{ data: ChatQualitySummary }>('/chat/feedback/summary'),
};
export const usageApi = {
  usage: () =>
    api.get<
      Sourced<{
        records: UsageRecord[];
        totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
      }>
    >('/usage'),
  cost: () => api.get<Sourced<BudgetStatus>>('/usage/cost'),
};

export interface AuditRecord extends AuditEvent {
  result: 'SUCCESS' | 'FAILURE' | 'DENIED';
}
export interface AuditSearchParams {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  result?: string;
  category?: string;
  text?: string;
  cursor?: string;
  limit?: number;
}
export interface AuditActionInfo {
  action: string;
  category: 'CONFIG' | 'SENSITIVE_QUERY';
  description: string;
}

export const auditApi = {
  list: (params: { action?: string; page?: number } = {}) =>
    api.get<Sourced<Paginated<AuditEvent>>>(`/audit${qs(params)}`),
  search: (params: AuditSearchParams) =>
    api.get<Sourced<{ items: AuditRecord[]; nextCursor: string | null; limit: number }>>(`/audit${qs({ limit: 50, ...params })}`),
  actions: () =>
    api.get<Sourced<{ actions: AuditActionInfo[]; categories: string[]; results: string[] }>>('/audit/actions'),
};

export interface SettingsView {
  general: { appName: string; environment: string; integrationMode: string };
  aws: { region: string; accountId: string | null; hasStaticCredentials: boolean };
  cloudwatch: { logGroup: string; logGroups: string[]; maxLogLines: number; queryWindowMinutes: number };
  dynamodb: { alertsTable: string; anomalyTypeGsi: string };
  ai: {
    primaryModelId: string;
    fallbackModelId: string;
    guardrailId: string;
    guardrailName: string;
    guardrailVersion: string;
    temperature: number;
    maxTokens: number;
    topP: number;
  };
  cost: { dailyBudgetUsd: number; monthlyBudgetUsd: number; softAlertUsd: number; hardAlertUsd: number };
  scheduler: { collectorMinutes: number };
  pipeline: {
    region: string;
    flow: string;
    collectorLambda: string;
    eventBridgeRule: string;
    collectorScheduleMinutes: number;
    alertWriterLambda: string;
    duplicateSuppressionMinutes: number;
    logsApiLambda: string;
    alertsApiLambda: string;
    chatLambda: string;
    registeredServices: Array<{ name: string; enabled: boolean }>;
  };
  integrations: Array<{ kind: string; displayName: string; mode: string; status: string }>;
}

export const settingsApi = {
  get: () => api.get<{ data: SettingsView }>('/settings').then((r) => r.data),
};

// ---- Notifications (DPI 2 item 6) ----
export type NotifChannel = 'EMAIL' | 'SLACK' | 'TEAMS';
export type NotifSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export interface NotifChannelStatus {
  channel: NotifChannel;
  status: 'CONFIGURED' | 'NOT_CONFIGURED' | 'DRY_RUN';
  destination: string | null;
  reason: string | null;
}
export interface NotifRule {
  id: string;
  name: string;
  enabled: boolean;
  minSeverity: NotifSeverity;
  services: string[];
  anomalyTypes: string[];
  channels: NotifChannel[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface NotifConnectionCheck {
  ok: boolean;
  topicName: string | null;
  subscriptionsConfirmed: number | null;
  subscriptionsPending: number | null;
  encrypted: boolean | null;
  message: string;
}
export type NotifRuleInput = Pick<NotifRule, 'name' | 'enabled' | 'minSeverity' | 'services' | 'anomalyTypes' | 'channels'>;
export interface NotifSettings {
  dedupWindowMinutes: number;
  maxPerHourPerChannel: number;
  updatedBy: string | null;
  updatedAt: string | null;
}
export interface NotifLogEntry {
  id: string;
  timestamp: string;
  alertId: string | null;
  ruleId: string | null;
  channel: NotifChannel;
  status: string;
  attempts: number;
  error: string | null;
  providerMessageId: string | null;
  isTest: boolean;
  summary: string | null;
}
export const notificationsApi = {
  channels: () => api.get<{ data: NotifChannelStatus[] }>('/notifications/channels').then((r) => r.data),
  rules: () => api.get<{ data: NotifRule[] }>('/notifications/rules').then((r) => r.data),
  createRule: (b: NotifRuleInput) => api.post<{ data: NotifRule }>('/notifications/rules', b).then((r) => r.data),
  updateRule: (id: string, b: Partial<NotifRuleInput>) =>
    api.put<{ data: NotifRule }>(`/notifications/rules/${encodeURIComponent(id)}`, b).then((r) => r.data),
  deleteRule: (id: string) => api.delete(`/notifications/rules/${encodeURIComponent(id)}`),
  settings: () => api.get<{ data: NotifSettings }>('/notifications/settings').then((r) => r.data),
  updateSettings: (b: { dedupWindowMinutes: number; maxPerHourPerChannel: number }) =>
    api.put<{ data: NotifSettings }>('/notifications/settings', b).then((r) => r.data),
  log: (params: { channel?: string; status?: string; alertId?: string; page?: number; pageSize?: number } = {}) =>
    api.get<{ data: { items: NotifLogEntry[]; page: number; pageSize: number; total: number } }>(`/notifications/log${qs(params)}`).then((r) => r.data),
  /** Read-only connection check (EMAIL / SNS only): subscriber counts, publishes nothing. */
  check: (channel: NotifChannel) =>
    api.post<{ data: NotifConnectionCheck }>('/notifications/check', { channel }).then((r) => r.data),
  test: (channel: NotifChannel, severity: NotifSeverity = 'CRITICAL') =>
    api.post<{ data: NotifLogEntry }>('/notifications/test', { channel, severity }).then((r) => r.data),
};

/** Per-user preferences (DPI 2 item 10). */
export interface UserPreferencesView {
  theme: ThemePreference;
  widgetLayout: Record<string, unknown> | null;
  /** null = the user has never saved preferences. */
  updatedAt: string | null;
}
export const preferencesApi = {
  get: () => api.get<{ data: UserPreferencesView }>('/preferences').then((r) => r.data),
  update: (b: { theme?: ThemePreference; widgetLayout?: Record<string, unknown> | null }) =>
    api.put<{ data: UserPreferencesView }>('/preferences', b).then((r) => r.data),
};

/** Service health / uptime panel (DPI 2 item 9). */
export const healthApi = {
  status: () => api.get<{ data: HealthStatusResponse }>('/health/status').then((r) => r.data),
  history: (target: string, range: HealthRange = '24h') =>
    api.get<{ data: HealthHistoryResponse }>(`/health/history?target=${encodeURIComponent(target)}&range=${range}`).then((r) => r.data),
  checkNow: () => api.post<{ data: HealthStatusResponse }>('/health/check-now', {}).then((r) => r.data),
};
