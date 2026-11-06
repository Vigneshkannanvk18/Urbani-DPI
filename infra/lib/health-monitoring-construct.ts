import { Construct } from 'constructs';
import {
  Annotations,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  Token,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_iam as iam,
  aws_route53 as route53,
  aws_s3 as s3,
  aws_sns as sns,
  aws_synthetics as synthetics,
} from 'aws-cdk-lib';

export interface HealthMonitoringConstructProps {
  /** HTTPS health endpoints (context `healthEndpoints`, comma-separated). Each one gets a Route 53 health check. */
  endpoints: string[];
  /** Optional SNS topic that receives the alarm notifications (reuse the alert topic when notifications are enabled). */
  alarmTopic?: sns.ITopic;
  /** Heartbeat canary schedule in minutes (default 5). */
  canaryEveryMinutes?: number;
}

export interface ParsedEndpoint {
  url: string;
  host: string;
  port: number;
  path: string;
}

/** Validates a configured endpoint: HTTPS only, no credentials, host given. Throws with a clear message. */
export function parseEndpoint(raw: string): ParsedEndpoint {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('healthEndpoints: an entry is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error(`healthEndpoints: ${u.hostname || 'an entry'} must use https`);
  if (u.username || u.password) throw new Error('healthEndpoints: credentials in a URL are not allowed');
  return { url: u.toString(), host: u.hostname, port: u.port ? Number(u.port) : 443, path: `${u.pathname}${u.search}` || '/' };
}

/**
 * Service health monitoring (DPI 2 item 9). AUTHORED, NOT DEPLOYED. Off unless `-c enableHealthMonitoring=true`.
 *
 *  - Route 53 health checks (HTTPS, every 30 s, 3 failures) for each endpoint in context `healthEndpoints`.
 *    NOTE: Route 53 publishes its health-check metrics only in us-east-1, so the CloudWatch alarms on them are
 *    created only when the stack is in us-east-1 (the ECS region today); elsewhere a warning is emitted.
 *  - A CloudWatch Synthetics heartbeat canary (inline Node.js, no browser) that GETs the same endpoints every few
 *    minutes and fails on a non-2xx/3xx answer, with an encrypted artifact bucket (30-day lifecycle), a minimal
 *    IAM role and a success-percentage alarm.
 *
 * The in-app health panel (backend probes, docs/HEALTH.md) works without any of this; these resources add an
 * independent external view. Container Insights (ECS cluster setting) is a deploy-script concern, tracked in item 14.
 */
export class HealthMonitoringConstruct extends Construct {
  readonly canary: synthetics.Canary;
  readonly artifactsBucket: s3.Bucket;
  readonly healthChecks: route53.CfnHealthCheck[] = [];

  constructor(scope: Construct, id: string, props: HealthMonitoringConstructProps) {
    super(scope, id);
    if (props.endpoints.length === 0) throw new Error('enableHealthMonitoring requires context healthEndpoints (comma-separated https URLs)');
    const endpoints = props.endpoints.map(parseEndpoint);
    const stack = Stack.of(this);

    // ---- Route 53 health checks ----
    endpoints.forEach((e, i) => {
      const hc = new route53.CfnHealthCheck(this, `HealthCheck${i + 1}`, {
        healthCheckConfig: {
          type: 'HTTPS',
          fullyQualifiedDomainName: e.host,
          port: e.port,
          resourcePath: e.path,
          requestInterval: 30,
          failureThreshold: 3,
          enableSni: true,
        },
        healthCheckTags: [{ key: 'Name', value: `urbani-health-${e.host}` }],
      });
      this.healthChecks.push(hc);
    });
    const regionKnown = !Token.isUnresolved(stack.region);
    if (!regionKnown || stack.region === 'us-east-1') {
      this.healthChecks.forEach((hc, i) => {
        const alarm = new cloudwatch.Alarm(this, `HealthCheckAlarm${i + 1}`, {
          alarmDescription: `Route 53 health check ${i + 1} is failing`,
          metric: new cloudwatch.Metric({
            namespace: 'AWS/Route53',
            metricName: 'HealthCheckStatus',
            dimensionsMap: { HealthCheckId: hc.attrHealthCheckId },
            statistic: 'Minimum',
            period: Duration.minutes(1),
          }),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          evaluationPeriods: 3,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        });
        if (props.alarmTopic) alarm.addAlarmAction(new cwActions.SnsAction(props.alarmTopic));
      });
    } else {
      Annotations.of(this).addWarning(
        `Route 53 health-check metrics exist only in us-east-1; alarms were not created in ${stack.region}. Deploy this stack in us-east-1 or alarm from there.`,
      );
    }

    // ---- Canary artifact bucket: encrypted, private, 30-day lifecycle ----
    this.artifactsBucket = new s3.Bucket(this, 'CanaryArtifacts', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ id: 'expire-canary-artifacts', enabled: true, expiration: Duration.days(30), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });

    // ---- Minimal canary role ----
    const role = new iam.Role(this, 'CanaryRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Urbani health heartbeat canary: write artifacts, logs and canary metrics only',
    });
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CanaryArtifacts', actions: ['s3:PutObject'], resources: [this.artifactsBucket.arnForObjects('*')] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CanaryBucketLocation', actions: ['s3:GetBucketLocation'], resources: [this.artifactsBucket.bucketArn] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CanaryListBuckets', actions: ['s3:ListAllMyBuckets'], resources: ['*'] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CanaryLogs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/cwsyn-*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CanaryMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudWatchSynthetics' } },
      }),
    );

    // ---- Heartbeat canary (HTTP only; the endpoints are baked into the inline script, which is not a secret) ----
    const urls = JSON.stringify(endpoints.map((e) => e.url));
    const code = [
      "const https = require('https');",
      `const URLS = ${urls};`,
      'const get = (u) => new Promise((resolve, reject) => {',
      '  const r = https.get(u, { timeout: 10000 }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });',
      '  r.on("timeout", () => r.destroy(new Error("timeout")));',
      '  r.on("error", reject);',
      '});',
      'exports.handler = async () => {',
      '  for (const u of URLS) {',
      '    const host = new URL(u).host;',
      '    const status = await get(u).catch((e) => { throw new Error("heartbeat failed for " + host + ": " + e.message); });',
      '    if (status < 200 || status >= 400) throw new Error("heartbeat for " + host + " returned HTTP " + status);',
      '  }',
      '};',
    ].join('\n');
    this.canary = new synthetics.Canary(this, 'Heartbeat', {
      canaryName: 'urbani-health-heartbeat',
      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_13_0,
      test: synthetics.Test.custom({ code: synthetics.Code.fromInline(code), handler: 'index.handler' }),
      schedule: synthetics.Schedule.rate(Duration.minutes(props.canaryEveryMinutes ?? 5)),
      artifactsBucketLocation: { bucket: this.artifactsBucket },
      role,
      startAfterCreation: true,
      successRetentionPeriod: Duration.days(7),
      failureRetentionPeriod: Duration.days(30),
    });
    const canaryAlarm = new cloudwatch.Alarm(this, 'HeartbeatAlarm', {
      alarmDescription: 'The Urbani health heartbeat canary is failing',
      metric: this.canary.metricSuccessPercent({ period: Duration.minutes(5), statistic: 'Average' }),
      threshold: 90,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    if (props.alarmTopic) canaryAlarm.addAlarmAction(new cwActions.SnsAction(props.alarmTopic));

    Tags.of(this).add('component', 'health-monitoring');
    new CfnOutput(this, 'HeartbeatCanaryName', { value: this.canary.canaryName });
    new CfnOutput(this, 'CanaryArtifactsBucket', { value: this.artifactsBucket.bucketName });
  }
}
