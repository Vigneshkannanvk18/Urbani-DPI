import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_lambda as lambda,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_dynamodb as dynamodb,
  Duration,
} from 'aws-cdk-lib';
import type { UrbaniConfig } from '../config';

/**
 * Orchestration (OrchestrationConstruct) — the event-driven collection loop.
 *
 *   EventBridge Scheduler (rate: N minutes)
 *     → Lambda Collector (query CW, invoke Bedrock)
 *     → Lambda Alert Writer (validate + write to DynamoDB)
 *
 * Lambda handler code is a documented PLACEHOLDER; real logic lands in Phase 2/3.
 * Model IDs and cadence come from config (never hardcoded).
 */
export interface OrchestrationProps {
  cfg: UrbaniConfig;
  collectorRole: iam.IRole;
  writerRole: iam.IRole;
  alertsTable: dynamodb.ITable;
}

export class OrchestrationConstruct extends Construct {
  readonly collectorFn: lambda.Function;
  readonly writerFn: lambda.Function;

  constructor(scope: Construct, id: string, props: OrchestrationProps) {
    super(scope, id);
    const { cfg, collectorRole, writerRole, alertsTable } = props;

    this.writerFn = new lambda.Function(this, 'UrbaniAlertWriterFn', {
      functionName: 'UrbaniAlertWriterFn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'writer')),
      role: writerRole,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        ALERTS_TABLE: cfg.alertsTable,
      },
    });
    // Grant the writer least-privilege write access to the alerts table only.
    alertsTable.grantWriteData(this.writerFn);

    this.collectorFn = new lambda.Function(this, 'UrbaniTelemetryCollectorFn', {
      functionName: 'UrbaniTelemetryCollectorFn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'collector')),
      role: collectorRole,
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        LOG_GROUP: cfg.logGroup,
        BEDROCK_MODEL_ID: cfg.bedrockModelId,
        BEDROCK_FALLBACK_MODEL_ID: cfg.bedrockFallbackModelId,
        GUARDRAIL_ID: cfg.guardrailId,
        MAX_LOG_LINES: String(cfg.maxLogLines),
        WRITER_FUNCTION_NAME: this.writerFn.functionName,
      },
    });
    // Collector may invoke the writer asynchronously.
    this.writerFn.grantInvoke(this.collectorFn);

    // EventBridge rule fires the collector on the documented cadence.
    new events.Rule(this, 'UrbaniCollectorSchedule', {
      ruleName: 'urbani-collector-schedule',
      schedule: events.Schedule.rate(Duration.minutes(cfg.scheduleMinutes)),
      targets: [new targets.LambdaFunction(this.collectorFn)],
      description: `Invokes the telemetry collector every ${cfg.scheduleMinutes} minutes`,
    });
  }
}
