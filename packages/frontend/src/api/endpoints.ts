import type {
  Sourced,
  Paginated,
  PersistedAlert,
  DashboardSummary,
  LogEntry,
  MetricSnapshot,
  ServiceSummary,
  UsageRecord,
  BudgetStatus,
  AuditEvent,
} from '@urbani/shared';
import { api, setToken, clearToken } from './client';

/** Typed wrappers around each documented API endpoint. */

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  permissions: string[];
}

export const authApi = {
  async login(email: string, password: string): Promise<AuthUser> {
    const res = await api.post<{ token: string; user: AuthUser }>('/auth/login', { email, password });
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

export const logsApi = {
  list: (params: { service?: string; level?: string; search?: string; page?: number } = {}) =>
    api.get<Sourced<Paginated<LogEntry>>>(`/logs${qs(params)}`),
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

export const auditApi = {
  list: (params: { action?: string; page?: number } = {}) =>
    api.get<Sourced<Paginated<AuditEvent>>>(`/audit${qs(params)}`),
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
