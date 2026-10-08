import { config } from '../config';
import { URBANI_QA_PIPELINE } from '../config/urbaniQa';
import { integrationRepository } from '../repositories/integrationRepository';
import { auditRepository } from '../repositories/auditRepository';

/**
 * Settings service (Epic 12).
 *
 * Exposes non-sensitive, mostly read-only configuration for the Settings page.
 * SECURITY: secrets (JWT secret, AWS keys) are NEVER returned. Only presence
 * flags and public placeholders are surfaced.
 */
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
  cost: {
    dailyBudgetUsd: number;
    monthlyBudgetUsd: number;
    softAlertUsd: number;
    hardAlertUsd: number;
  };
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

/**
 * Derive the live mode/status of an integration from RUNTIME config rather than
 * the seed rows. The seed stores every integration as MOCK/WAITING_FOR_INTEGRATION,
 * which is wrong once an integration is actually configured (e.g. the Urbani logs
 * API in INTEGRATION_MODE=live). This reconciler reflects what is truly wired now.
 *
 * Known runtime truths today:
 *  - CloudWatch logs are served LIVE when INTEGRATION_MODE=live AND the Urbani
 *    logs API is configured (base URL + key present). Otherwise MOCK.
 *  - URBANI_APP log source follows the same condition (it is the same upstream).
 *  - Bedrock (AI chat) and DynamoDB (AI-generated alerts) are now genuinely live
 *    under the same condition: chat answers come from the real Bedrock Nova 2 Lite
 *    /chat endpoint and alerts come from the real /alerts endpoints. They report
 *    LIVE/CONNECTED in live mode, else the honest seeded "waiting" state.
 */
function runtimeIntegrationState(
  kind: string,
  seededMode: string,
  seededStatus: string,
): { mode: string; status: string } {
  const logsLive = config.integrationMode === 'live' && config.urbani.logsConfigured;
  switch (kind) {
    case 'CLOUDWATCH':
    case 'URBANI_APP':
    case 'BEDROCK':
    case 'DYNAMODB':
      return logsLive
        ? { mode: 'LIVE', status: 'CONNECTED' }
        : { mode: 'MOCK', status: 'WAITING_FOR_INTEGRATION' };
    default:
      return { mode: seededMode, status: seededStatus };
  }
}

export const settingsService = {
  get(): SettingsView {
    return {
      general: {
        appName: config.appName,
        environment: config.env,
        integrationMode: config.integrationMode,
      },
      aws: {
        region: config.aws.region,
        accountId: config.aws.accountId,
        hasStaticCredentials: config.aws.hasStaticCredentials,
      },
      cloudwatch: {
        logGroup: config.cloudwatch.logGroup,
        logGroups: config.urbani.logGroups,
        maxLogLines: config.cloudwatch.maxLogLines,
        queryWindowMinutes: config.cloudwatch.queryWindowMinutes,
      },
      dynamodb: {
        alertsTable: config.dynamodb.alertsTable,
        anomalyTypeGsi: config.dynamodb.anomalyTypeGsi,
      },
      ai: {
        primaryModelId: config.bedrock.primaryModelId,
        fallbackModelId: config.bedrock.fallbackModelId,
        guardrailId: config.bedrock.guardrailId,
        guardrailName: config.bedrock.guardrailName,
        guardrailVersion: config.bedrock.guardrailVersion,
        temperature: config.bedrock.inference.temperature,
        maxTokens: config.bedrock.inference.maxTokens,
        topP: config.bedrock.inference.topP,
      },
      cost: {
        dailyBudgetUsd: config.cost.dailyBudgetUsd,
        monthlyBudgetUsd: config.cost.monthlyBudgetUsd,
        softAlertUsd: config.cost.softAlertUsd,
        hardAlertUsd: config.cost.hardAlertUsd,
      },
      scheduler: { collectorMinutes: config.scheduler.collectorMinutes },
      pipeline: {
        region: URBANI_QA_PIPELINE.region,
        flow: URBANI_QA_PIPELINE.flow,
        collectorLambda: URBANI_QA_PIPELINE.collectorLambda,
        eventBridgeRule: URBANI_QA_PIPELINE.eventBridgeRule,
        collectorScheduleMinutes: URBANI_QA_PIPELINE.collectorScheduleMinutes,
        alertWriterLambda: URBANI_QA_PIPELINE.alertWriterLambda,
        duplicateSuppressionMinutes: URBANI_QA_PIPELINE.duplicateSuppressionMinutes,
        logsApiLambda: URBANI_QA_PIPELINE.logsApiLambda,
        alertsApiLambda: URBANI_QA_PIPELINE.alertsApiLambda,
        chatLambda: URBANI_QA_PIPELINE.chatLambda,
        registeredServices: URBANI_QA_PIPELINE.registeredServices.map((s) => ({
          name: s.name,
          enabled: s.enabled,
        })),
      },
      integrations: integrationRepository.all().map((i) => {
        const live = runtimeIntegrationState(i.kind, i.mode, i.status);
        return {
          kind: i.kind,
          displayName: i.display_name,
          mode: live.mode,
          status: live.status,
        };
      }),
    };
  },

  /**
   * Phase 1 settings are effectively read-only (values are env-driven). We accept
   * an update request only to audit the intent; we do NOT mutate secrets or env
   * config from the UI. Real mutable settings arrive in a later phase.
   */
  update(actor: string, requested: Record<string, unknown>): { accepted: false; reason: string } {
    auditRepository.record(actor, 'CONFIG_CHANGED', 'settings', {
      requestedKeys: Object.keys(requested),
    });
    return {
      accepted: false,
      reason:
        'Settings are read-only in Phase 1 (config is environment-driven). The change request was audited.',
    };
  },
};
