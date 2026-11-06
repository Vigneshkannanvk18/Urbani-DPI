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
  create: (u: { email: string; displayName: string; role: UserRole; password: string }) =>
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
}

export const chatApi = {
  ask: (question: string, opts: { service?: string; environment?: string; history?: ChatTurn[] } = {}) =>
    api.post<Sourced<ChatAnswer>>('/chat', { question, ...opts }),
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
