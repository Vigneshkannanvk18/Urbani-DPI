import type {
  LogEntry,
  MetricSnapshot,
  ServiceSummary,
  UrbaniIncidentAlert,
  DataSource,
} from '@urbani/shared';

/**
 * Integration boundary contracts (Phase 1 Mock/Adapter strategy).
 *
 * These interfaces are the ONLY thing the service layer knows about external
 * systems. Phase 1 ships Mock* implementations; Phase 2 ships AWS* / real
 * implementations that satisfy the exact same contracts. Nothing above this
 * boundary (services, API, dashboard) changes when the real adapters land.
 *
 * RULE: the frontend NEVER calls these; only the service layer does, only via
 * these interfaces — never a concrete AWS SDK type.
 */

/** Common metadata every adapter reports so provenance is always visible. */
export interface AdapterMeta {
  /** LIVE once backed by real AWS; MOCK / WAITING_FOR_INTEGRATION otherwise. */
  source: DataSource;
  note?: string;
}

export interface WithMeta<T> {
  meta: AdapterMeta;
  value: T;
}

// -------------------- CloudWatch --------------------
export interface CloudWatchLogQuery {
  service?: string;
  environment?: string;
  level?: string;
  search?: string;
  startTime?: string;
  endTime?: string;
  /** Hard cap; documented architecture limits to 100 lines per cycle. */
  limit?: number;
}

export interface CloudWatchMetricQuery {
  service?: string;
  environment?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface CloudWatchAdapter {
  readonly kind: 'CLOUDWATCH';
  getLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>>;
  getMetrics(query: CloudWatchMetricQuery): Promise<WithMeta<MetricSnapshot[]>>;
}

// -------------------- Bedrock (raw model invocation) --------------------
export interface BedrockInvokeParams {
  modelId: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  guardrailId?: string;
}

export interface BedrockInvokeResult {
  /** Raw model text output (expected to be strict JSON per the system prompt). */
  outputText: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** True if guardrails intervened (e.g. PII redaction / blocked content). */
  guardrailIntervened: boolean;
}

export interface BedrockAdapter {
  readonly kind: 'BEDROCK';
  invokeModel(params: BedrockInvokeParams): Promise<WithMeta<BedrockInvokeResult>>;
}

// -------------------- DynamoDB (alert persistence) --------------------
export interface AlertQuery {
  service?: string;
  environment?: string;
  severity?: string;
  anomalyType?: string;
  status?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface DynamoDBAdapter {
  readonly kind: 'DYNAMODB';
  putAlert(alert: UrbaniIncidentAlert): Promise<WithMeta<void>>;
  getAlert(alertId: string): Promise<WithMeta<UrbaniIncidentAlert | null>>;
  queryAlerts(query: AlertQuery): Promise<WithMeta<{ items: UrbaniIncidentAlert[]; total: number }>>;
}

// -------------------- Urbani Application (service discovery) --------------------
export interface UrbaniApplicationAdapter {
  readonly kind: 'URBANI_APP';
  /** Discover the monitored services/environments (EB service discovery in P2). */
  discoverServices(): Promise<WithMeta<ServiceSummary[]>>;
}
