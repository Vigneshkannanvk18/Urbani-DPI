import { config } from '../config';
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
  aws: { region: string; hasStaticCredentials: boolean };
  cloudwatch: { logGroup: string; maxLogLines: number; queryWindowMinutes: number };
  dynamodb: { alertsTable: string; anomalyTypeGsi: string };
  ai: {
    primaryModelId: string;
    fallbackModelId: string;
    guardrailId: string;
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
  integrations: Array<{ kind: string; displayName: string; mode: string; status: string }>;
}

export const settingsService = {
  get(): SettingsView {
    return {
      general: {
        appName: config.appName,
        environment: config.env,
        integrationMode: config.integrationMode,
      },
      aws: { region: config.aws.region, hasStaticCredentials: config.aws.hasStaticCredentials },
      cloudwatch: {
        logGroup: config.cloudwatch.logGroup,
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
      integrations: integrationRepository.all().map((i) => ({
        kind: i.kind,
        displayName: i.display_name,
        mode: i.mode,
        status: i.status,
      })),
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
