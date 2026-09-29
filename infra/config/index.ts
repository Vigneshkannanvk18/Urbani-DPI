/**
 * Deploy-time configuration for the Urbani CDK app.
 *
 * All account/region/model values come from CDK context or environment
 * variables — NOTHING is hardcoded. Provide values at synth/deploy time, e.g.:
 *
 *   cdk synth \
 *     -c account=123456789012 -c region=ap-south-1 \
 *     -c bedrockModelId=anthropic.claude-3-5-sonnet-20241022-v2:0
 *
 * or via env: CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION / URBANI_BEDROCK_MODEL_ID.
 */
import type { Construct } from 'constructs';

export interface UrbaniConfig {
  account?: string;
  region: string;
  /** EB CloudWatch log group the collector reads (read-only). */
  logGroup: string;
  /** Bedrock model + guardrail — config-driven, never hardcoded in business logic. */
  bedrockModelId: string;
  bedrockFallbackModelId: string;
  guardrailId: string;
  /** Telemetry cadence + caps (cost control). */
  scheduleMinutes: number;
  maxLogLines: number;
  /** DynamoDB table + GSI. */
  alertsTable: string;
  anomalyTypeGsi: string;
  /** AWS Budgets soft/hard alert thresholds (USD). */
  budgetSoftUsd: number;
  budgetHardUsd: number;
}

function ctx<T extends string | number>(
  scope: Construct,
  key: string,
  env: string | undefined,
  fallback: T,
): T {
  const fromCtx = scope.node.tryGetContext(key);
  const raw = fromCtx ?? env ?? fallback;
  return (typeof fallback === 'number' ? Number(raw) : String(raw)) as T;
}

export function loadConfig(scope: Construct): UrbaniConfig {
  return {
    // Account/region resolved from context or the standard CDK env vars.
    account: scope.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: ctx(scope, 'region', process.env.CDK_DEFAULT_REGION, 'ap-south-1'),
    logGroup: ctx(scope, 'logGroup', process.env.URBANI_LOG_GROUP, '/aws/elasticbeanstalk/urbani-app'),
    bedrockModelId: ctx(
      scope,
      'bedrockModelId',
      process.env.URBANI_BEDROCK_MODEL_ID,
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
    ),
    bedrockFallbackModelId: ctx(
      scope,
      'bedrockFallbackModelId',
      process.env.URBANI_BEDROCK_FALLBACK_MODEL_ID,
      'amazon.nova-lite-v1:0',
    ),
    guardrailId: ctx(scope, 'guardrailId', process.env.URBANI_GUARDRAIL_ID, 'urbani-dpi-guardrail-v1'),
    scheduleMinutes: ctx(scope, 'scheduleMinutes', process.env.URBANI_SCHEDULE_MINUTES, 5),
    maxLogLines: ctx(scope, 'maxLogLines', process.env.URBANI_MAX_LOG_LINES, 100),
    alertsTable: ctx(scope, 'alertsTable', process.env.URBANI_ALERTS_TABLE, 'UrbaniAlerts'),
    anomalyTypeGsi: ctx(scope, 'anomalyTypeGsi', process.env.URBANI_ANOMALY_GSI, 'anomaly_type-index'),
    budgetSoftUsd: ctx(scope, 'budgetSoftUsd', process.env.URBANI_BUDGET_SOFT, 50),
    budgetHardUsd: ctx(scope, 'budgetHardUsd', process.env.URBANI_BUDGET_HARD, 100),
  };
}
