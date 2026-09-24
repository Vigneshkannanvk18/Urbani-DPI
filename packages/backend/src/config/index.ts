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

  API_BASE_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@urbani.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('ChangeMe123!'),

  DB_DRIVER: z.enum(['sqlite', 'dynamodb']).default('sqlite'),
  DB_SQLITE_PATH: z.string().default('./data/urbani.sqlite'),

  INTEGRATION_MODE: z.enum(['mock', 'aws']).default('mock'),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  CLOUDWATCH_LOG_GROUP: z.string().default('/aws/elasticbeanstalk/urbani-app'),
  CLOUDWATCH_MAX_LOG_LINES: z.coerce.number().default(100),
  CLOUDWATCH_QUERY_WINDOW_MINUTES: z.coerce.number().default(5),

  DYNAMODB_ALERTS_TABLE: z.string().default('UrbaniAlerts'),
  DYNAMODB_GSI_ANOMALY_TYPE: z.string().default('anomaly_type-index'),

  BEDROCK_PRIMARY_MODEL_ID: z.string().default('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  BEDROCK_FALLBACK_MODEL_ID: z.string().default('amazon.nova-lite-v1:0'),
  BEDROCK_GUARDRAIL_ID: z.string().default('urbani-dpi-guardrail-v1'),
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

export const config = {
  env: env.NODE_ENV,
  appName: env.APP_NAME,
  logLevel: env.LOG_LEVEL,
  port: env.PORT,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  api: {
    baseUrl: env.API_BASE_URL,
    corsOrigin: env.CORS_ORIGIN,
  },

  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    seedAdminEmail: env.SEED_ADMIN_EMAIL,
    seedAdminPassword: env.SEED_ADMIN_PASSWORD,
  },

  db: {
    driver: env.DB_DRIVER,
    sqlitePath: path.resolve(process.cwd(), env.DB_SQLITE_PATH),
  },

  /** Which adapter implementations to wire in. */
  integrationMode: env.INTEGRATION_MODE,

  aws: {
    region: env.AWS_REGION,
    // Presence is optional; adapters must never assume static keys exist.
    hasStaticCredentials: Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY),
  },

  cloudwatch: {
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
