import { Construct } from 'constructs';
import { Stack, StackProps, CfnOutput, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../config';
import { SecurityConstruct } from './security-construct';
import { PersistenceConstruct } from './persistence-construct';
import { OrchestrationConstruct } from './orchestration-construct';
import { CostConstruct } from './cost-construct';
import { DashboardConstruct } from './dashboard-construct';

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
    new OrchestrationConstruct(this, 'Orchestration', {
      cfg,
      collectorRole: security.collectorRole,
      writerRole: security.writerRole,
      alertsTable: persistence.alertsTable,
    });
    new CostConstruct(this, 'Cost', cfg);
    new DashboardConstruct(this, 'Dashboard', cfg);

    // Consistent tagging for cost allocation + governance.
    Tags.of(this).add('project', 'urbani-observability');
    Tags.of(this).add('managed-by', 'cdk');

    new CfnOutput(this, 'AlertsTableName', { value: persistence.alertsTable.tableName });
    new CfnOutput(this, 'BedrockModelId', { value: cfg.bedrockModelId });
    new CfnOutput(this, 'GuardrailId', { value: cfg.guardrailId });
    new CfnOutput(this, 'CollectorCadenceMinutes', { value: String(cfg.scheduleMinutes) });
  }
}
