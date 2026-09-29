import { Construct } from 'constructs';
import { aws_kms as kms, aws_iam as iam, aws_cloudtrail as cloudtrail, RemovalPolicy } from 'aws-cdk-lib';
import type { UrbaniConfig } from '../config';

/**
 * Security & governance foundation (SecurityConstruct).
 *
 *  - KMS CMK for encryption at rest (DynamoDB, logs, Bedrock invocation logs).
 *  - CloudTrail for auditing every Bedrock / Lambda / DynamoDB API call.
 *  - Least-privilege execution roles for the collector and writer Lambdas.
 *
 * Principle: the MVP is READ-ONLY against production. The collector role has
 * read-only CloudWatch + bedrock:InvokeModel and NO write access to app infra.
 */
export class SecurityConstruct extends Construct {
  readonly key: kms.Key;
  readonly collectorRole: iam.Role;
  readonly writerRole: iam.Role;

  constructor(scope: Construct, id: string, cfg: UrbaniConfig) {
    super(scope, id);

    // Customer-managed key used across the stack.
    this.key = new kms.Key(this, 'UrbaniKmsKey', {
      alias: 'alias/urbani-observability',
      enableKeyRotation: true,
      description: 'Urbani Observability encryption key (DynamoDB, logs, Bedrock logs)',
      removalPolicy: RemovalPolicy.RETAIN, // never auto-delete a key with data under it
    });

    // Audit trail for all management + data-plane API calls.
    new cloudtrail.Trail(this, 'UrbaniTrail', {
      trailName: 'urbani-observability-trail',
      encryptionKey: this.key,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: false,
    });

    // Collector execution role — strict least privilege (read-only + Bedrock invoke).
    this.collectorRole = new iam.Role(this, 'UrbaniCollectorRole', {
      roleName: 'UrbaniCollectorExecutionRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Read-only CloudWatch access + bedrock:InvokeModel. No prod write access.',
    });
    this.collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:StartQuery', 'logs:GetQueryResults', 'cloudwatch:GetMetricData'],
        // Scope to Urbani EB log groups only.
        resources: [`arn:aws:logs:${cfg.region}:*:log-group:/aws/elasticbeanstalk/urbani-*`],
      }),
    );
    this.collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        // Restrict to the configured foundation model(s).
        resources: [
          `arn:aws:bedrock:${cfg.region}::foundation-model/${cfg.bedrockModelId}`,
          `arn:aws:bedrock:${cfg.region}::foundation-model/${cfg.bedrockFallbackModelId}`,
        ],
      }),
    );
    this.collectorRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    // Writer execution role — only writes to the alerts table (granted in persistence).
    this.writerRole = new iam.Role(this, 'UrbaniWriterRole', {
      roleName: 'UrbaniWriterExecutionRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Writes validated alerts to DynamoDB only.',
    });
    this.writerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
  }
}
