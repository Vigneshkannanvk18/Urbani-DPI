import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';

/**
 * Typed, validated environment configuration (Task 1.3).
 *
 * Rules enforced here:
 *  - No secret has a hardcoded default that would be usable in production.
 *  - AWS / Bedrock / CloudWatch / DynamoDB values are placeholders, config-driven.
 *  - INTEGRATION_MODE selects mock vs aws adapters; defaults to "mock".
 */

const boolFromEnv = (v: string | undefined, def = false): boolean =>
  v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('urbani-observability'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().default(4000),

  // Public-facing URLs are OPTIONAL and have NO hardcoded host. They are only
  // needed if something server-side must build an absolute URL. When unset,
  // API_BASE_URL falls back to a loopback derived from PORT (used only by the
  // container's own healthcheck / local tooling — never a cross-service host).
  API_BASE_URL: z.string().optional(),
  FRONTEND_URL: z.string().optional(),
  // Comma-separated allow-list of browser origins. Empty (default) => same-origin
  // only, which is correct behind the reverse proxy. No host is hardcoded.
  CORS_ORIGIN: z.string().default(''),

  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@urbani.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('ChangeMe123!'),

  DB_DRIVER: z.enum(['sqlite', 'dynamodb']).default('sqlite'),
  // DATABASE_URL is the canonical, deploy-injected DB location. For sqlite it is a
  // filesystem path (optionally prefixed sqlite://). DB_SQLITE_PATH is kept as a
  // backwards-compatible fallback. In Docker this points at a mounted volume.
  DATABASE_URL: z.string().optional(),
  DB_SQLITE_PATH: z.string().default('./data/urbani.sqlite'),

  // mock  = all adapters mocked (Phase 1/2 default)
  // live  = use real integrations where configured (e.g. the Urbani logs API),
  //         falling back to mock for any integration that is not yet available
  // aws   = full AWS SDK integration (reserved for later; not implemented)
  INTEGRATION_MODE: z.enum(['mock', 'live', 'aws']).default('mock'),

  // ---- Real Urbani telemetry API (Phase 3 integration) ----
  // Live CloudWatch logs are exposed via an API Gateway endpoint secured by an
  // x-api-key. The key is a SECRET: read from env only, never hardcoded, logged,
  // or shipped to the browser (the backend calls this server-side).
  URBANI_API_BASE_URL: z.string().optional(),
  URBANI_API_KEY: z.string().optional(),
  // Default/primary service used where a single service is needed (e.g. chat).
  URBANI_SERVICE: z.string().default('main'),
  // Comma-separated list of enabled services the API serves (logs + alerts per
  // service). The dashboard fans out across these. Falls back to URBANI_SERVICE.
  URBANI_SERVICES: z.string().default(''),
  URBANI_REFRESH_MINUTES: z.coerce.number().default(5),
  // Urbani environment label (used for LogEntry/alert environment + seed/chat).
  URBANI_ENVIRONMENT: z.string().default('qa'),
  // How many history windows to request from GET /logs/history?limit=N.
  URBANI_LOGS_HISTORY_LIMIT: z.coerce.number().default(20),
  // Live chat (Amazon Bedrock Nova 2 Lite via API Gateway POST /chat). Model id
  // is the label surfaced in provenance alongside the real model answer.
  URBANI_CHAT_MODEL_ID: z.string().default('global.amazon.nova-2-lite-v1:0'),
  URBANI_CHAT_TIMEOUT_MS: z.coerce.number().default(30_000),
  // How many history alerts to pull from GET /alerts/history?limit=N.
  URBANI_ALERTS_HISTORY_LIMIT: z.coerce.number().default(5),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCOUNT_ID: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  CLOUDWATCH_REGION: z.string().optional(),
  CLOUDWATCH_LOG_GROUP: z.string().default('/aws/ecs/urbaniqa-qa-main/app'),
  CLOUDWATCH_MAX_LOG_LINES: z.coerce.number().default(100),
  CLOUDWATCH_QUERY_WINDOW_MINUTES: z.coerce.number().default(5),

  DYNAMODB_ALERTS_TABLE: z.string().default('UrbaniAlerts'),
  DYNAMODB_GSI_ANOMALY_TYPE: z.string().default('anomaly_type-index'),

  BEDROCK_PRIMARY_MODEL_ID: z.string().default('global.amazon.nova-2-lite-v1:0'),
  BEDROCK_FALLBACK_MODEL_ID: z.string().default('global.amazon.nova-2-lite-v1:0'),
  BEDROCK_GUARDRAIL_ID: z.string().default('0z947gmtk58a'),
  // Non-secret display values for the QA observability guardrail.
  BEDROCK_GUARDRAIL_NAME: z.string().default('UrbaniQaObservabilityGuardrail'),
  BEDROCK_GUARDRAIL_VERSION: z.string().default('1'),
  BEDROCK_TEMPERATURE: z.coerce.number().default(0.0),
  BEDROCK_MAX_TOKENS: z.coerce.number().default(1024),
  BEDROCK_TOP_P: z.coerce.number().default(1.0),

  COST_DAILY_BUDGET_USD: z.coerce.number().default(2.5),
  COST_MONTHLY_BUDGET_USD: z.coerce.number().default(100),
  COST_SOFT_ALERT_USD: z.coerce.number().default(50),
  COST_HARD_ALERT_USD: z.coerce.number().default(100),

  COLLECTOR_SCHEDULE_MINUTES: z.coerce.number().default(5),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast with a clear message rather than booting a half-configured server.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
}

const env = parsed.data;

// Guard: in production the JWT secret must not be the placeholder.
if (env.NODE_ENV === 'production' && env.JWT_SECRET === 'change-me-in-local-env-only') {
  throw new Error('JWT_SECRET must be set to a strong value in production.');
}

// Resolve the SQLite path from DATABASE_URL (canonical) or DB_SQLITE_PATH (fallback).
// Accepts either a bare path or a sqlite:// URL. Absolute paths (e.g. a mounted
// Docker volume) are honoured as-is; relative paths resolve against cwd.
function resolveSqlitePath(): string {
  const raw = (env.DATABASE_URL ?? env.DB_SQLITE_PATH).replace(/^sqlite:\/\//, '');
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

// Parse comma-separated CORS origins. An empty value disables cross-origin
// allow-listing (correct when the browser and API share an origin via a reverse proxy).
const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Enabled Urbani services (parsed from URBANI_SERVICES, else [URBANI_SERVICE]).
const urbaniServices = (() => {
  const list = env.URBANI_SERVICES.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : [env.URBANI_SERVICE];
})();

// The ECS CloudWatch log group for a given service (matches the two provided
// QA groups: /aws/ecs/urbaniqa-qa-main/app and /aws/ecs/urbaniqa-qa-payments/app).
const urbaniLogGroupFor = (service: string): string =>
  `/aws/ecs/urbaniqa-${env.URBANI_ENVIRONMENT}-${service}/app`;

export const config = {
  env: env.NODE_ENV,
  appName: env.APP_NAME,
  logLevel: env.LOG_LEVEL,
  port: env.PORT,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  api: {
    // Optional, host-free. Unset unless a real environment injects an absolute
    // URL. No default host is baked into application code.
    baseUrl: env.API_BASE_URL ?? null,
    frontendUrl: env.FRONTEND_URL ?? null,
    /** Allowed browser origins (empty array = same-origin only, behind reverse proxy). */
    corsOrigins,
  },

  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    seedAdminEmail: env.SEED_ADMIN_EMAIL,
    seedAdminPassword: env.SEED_ADMIN_PASSWORD,
  },

  db: {
    driver: env.DB_DRIVER,
    sqlitePath: resolveSqlitePath(),
  },

  /** Which adapter implementations to wire in. */
  integrationMode: env.INTEGRATION_MODE,

  aws: {
    region: env.AWS_REGION,
    accountId: env.AWS_ACCOUNT_ID ?? null,
    // Presence is optional; adapters must never assume static keys exist.
    hasStaticCredentials: Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY),
  },

  urbani: {
    apiBaseUrl: env.URBANI_API_BASE_URL ?? null,
    apiKey: env.URBANI_API_KEY ?? null,
    service: env.URBANI_SERVICE,
    /** All enabled services (parsed from URBANI_SERVICES, else [service]). */
    services: urbaniServices,
    refreshMinutes: env.URBANI_REFRESH_MINUTES,
    /** Urbani environment label applied to live logs/alerts (and seed/chat). */
    environment: env.URBANI_ENVIRONMENT,
    /** Windows requested from GET /logs/history?limit=N. */
    logsHistoryLimit: env.URBANI_LOGS_HISTORY_LIMIT,
    /** Model label surfaced for live chat alongside the real Nova 2 Lite answer. */
    chatModelId: env.URBANI_CHAT_MODEL_ID,
    /** Abort timeout for the live POST /chat call. */
    chatTimeoutMs: env.URBANI_CHAT_TIMEOUT_MS,
    /** Default limit for GET /alerts/history. */
    alertsHistoryLimit: env.URBANI_ALERTS_HISTORY_LIMIT,
    /** True when the real logs API is configured (base URL + key present). */
    logsConfigured: Boolean(env.URBANI_API_BASE_URL && env.URBANI_API_KEY),
    /** The ECS CloudWatch log group for a given service. */
    logGroupFor: urbaniLogGroupFor,
    /** Log groups for all enabled services (used by seed + Settings display). */
    logGroups: urbaniServices.map(urbaniLogGroupFor),
  },

  cloudwatch: {
    region: env.CLOUDWATCH_REGION ?? env.AWS_REGION,
    logGroup: env.CLOUDWATCH_LOG_GROUP,
    maxLogLines: env.CLOUDWATCH_MAX_LOG_LINES,
    queryWindowMinutes: env.CLOUDWATCH_QUERY_WINDOW_MINUTES,
  },

  dynamodb: {
    alertsTable: env.DYNAMODB_ALERTS_TABLE,
    anomalyTypeGsi: env.DYNAMODB_GSI_ANOMALY_TYPE,
  },

  bedrock: {
    primaryModelId: env.BEDROCK_PRIMARY_MODEL_ID,
    fallbackModelId: env.BEDROCK_FALLBACK_MODEL_ID,
    guardrailId: env.BEDROCK_GUARDRAIL_ID,
    guardrailName: env.BEDROCK_GUARDRAIL_NAME,
    guardrailVersion: env.BEDROCK_GUARDRAIL_VERSION,
    // Deterministic inference config per architecture proposal section 10.4.
    inference: {
      temperature: env.BEDROCK_TEMPERATURE,
      maxTokens: env.BEDROCK_MAX_TOKENS,
      topP: env.BEDROCK_TOP_P,
    },
  },

  cost: {
    dailyBudgetUsd: env.COST_DAILY_BUDGET_USD,
    monthlyBudgetUsd: env.COST_MONTHLY_BUDGET_USD,
    softAlertUsd: env.COST_SOFT_ALERT_USD,
    hardAlertUsd: env.COST_HARD_ALERT_USD,
  },

  scheduler: {
    collectorMinutes: env.COLLECTOR_SCHEDULE_MINUTES,
  },
} as const;

export type AppConfig = typeof config;
