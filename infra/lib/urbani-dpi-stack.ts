import { Construct } from 'constructs';
import { Stack, StackProps, CfnOutput, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../config';
import { SecurityConstruct } from './security-construct';
import { PersistenceConstruct } from './persistence-construct';
import { OrchestrationConstruct } from './orchestration-construct';
import { CostConstruct } from './cost-construct';
import { DashboardConstruct } from './dashboard-construct';
import { CognitoConstruct } from './cognito-construct';
import { NotificationsConstruct } from './notifications-construct';
import { HealthMonitoringConstruct } from './health-monitoring-construct';

const truthy = (v: unknown): boolean => v === true || (typeof v === 'string' && ['1', 'true', 'yes'].includes(v.toLowerCase()));

/**
 * UrbaniDpiStack — composes the documented architecture into one stack:
 *   Security → Persistence → Orchestration → Cost → Dashboard.
 *
 * Synth-ready skeleton. Bedrock Guardrails (urbani-dpi-guardrail-v1) are managed
 * as a Bedrock resource/console artifact referenced by the collector's env; the
 * guardrail ID is config-driven. Nothing here auto-deploys.
 */
export class UrbaniDpiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const cfg = loadConfig(this);

    const security = new SecurityConstruct(this, 'Security', cfg);
    const persistence = new PersistenceConstruct(this, 'Persistence', cfg, security.key);
    persistence.grantAppDataAccess(security.dashboardTaskRole);
    new OrchestrationConstruct(this, 'Orchestration', {
      cfg,
      collectorRole: security.collectorRole,
      writerRole: security.writerRole,
      alertsTable: persistence.alertsTable,
    });
    new CostConstruct(this, 'Cost', cfg);
    new DashboardConstruct(this, 'Dashboard', cfg, security.dashboardTaskRole);

    // SSO (DPI 2 item 5): authored only; off unless `-c enableCognito=true`. Existing stack is unchanged by default.
    if (truthy(this.node.tryGetContext('enableCognito'))) {
      const list = (k: string): string[] =>
        String(this.node.tryGetContext(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const callbackUrls = list('cognitoCallbackUrls');
      if (callbackUrls.length === 0) throw new Error('enableCognito requires context cognitoCallbackUrls (comma-separated)');
      new CognitoConstruct(this, 'Cognito', {
        domainPrefix: String(this.node.tryGetContext('cognitoDomainPrefix') ?? 'urbani-radar'),
        callbackUrls,
        logoutUrls: list('cognitoLogoutUrls').length ? list('cognitoLogoutUrls') : callbackUrls,
        googleSecretArn: this.node.tryGetContext('cognitoGoogleSecretArn') || undefined,
      });
    }
    // Alert notifier (DPI 2 item 6): authored only; off unless `-c enableNotifications=true`. The engine runs in the backend.
    let notifications: NotificationsConstruct | undefined;
    if (truthy(this.node.tryGetContext('enableNotifications'))) {
      notifications = new NotificationsConstruct(this, 'Notifications', {
        key: security.key,
        taskRole: security.dashboardTaskRole,
        alertEmails: String(this.node.tryGetContext('alertEmails') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        slackWebhookSecretName: this.node.tryGetContext('slackWebhookSecretName') || undefined,
        teamsWebhookSecretName: this.node.tryGetContext('teamsWebhookSecretName') || undefined,
      });
    }

    // Health monitoring (DPI 2 item 9): authored only; off unless `-c enableHealthMonitoring=true` (+ `healthEndpoints`).
    if (truthy(this.node.tryGetContext('enableHealthMonitoring'))) {
      new HealthMonitoringConstruct(this, 'HealthMonitoring', {
        endpoints: String(this.node.tryGetContext('healthEndpoints') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        alarmTopic: notifications?.topic,
      });
    }
    // Consistent tagging for cost allocation + governance.
    Tags.of(this).add('project', 'urbani-observability');
    Tags.of(this).add('managed-by', 'cdk');

    new CfnOutput(this, 'AlertsTableName', { value: persistence.alertsTable.tableName });
    new CfnOutput(this, 'AppTableName', { value: persistence.appTable.tableName });
    new CfnOutput(this, 'BedrockModelId', { value: cfg.bedrockModelId });
    new CfnOutput(this, 'GuardrailId', { value: cfg.guardrailId });
    new CfnOutput(this, 'CollectorCadenceMinutes', { value: String(cfg.scheduleMinutes) });
  }
}
