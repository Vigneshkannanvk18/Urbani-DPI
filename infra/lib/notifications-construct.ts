import { Construct } from 'constructs';
import {
  CfnOutput,
  Stack,
  aws_iam as iam,
  aws_kms as kms,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
} from 'aws-cdk-lib';

export interface NotificationsConstructProps {
  /** The stack CMK; the topic is encrypted with it (same convention as the tables and logs). */
  key: kms.IKey;
  /** The dashboard backend task role; receives sns:Publish on this topic only. */
  taskRole: iam.IRole;
  /** Optional e-mail subscribers (context `alertEmails`). Each recipient must confirm the subscription e-mail from AWS. */
  alertEmails: string[];
  /** Optional names of EXISTING Secrets Manager secrets holding the webhook URLs (context). Values never live in code. */
  slackWebhookSecretName?: string;
  teamsWebhookSecretName?: string;
}

/**
 * Alert notifier infrastructure (DPI 2 item 6). AUTHORED, NOT DEPLOYED. Off unless `-c enableNotifications=true`.
 *
 * The notification engine runs INSIDE the backend (docs/NOTIFICATIONS.md), so the only AWS pieces are:
 *  - an SNS topic (KMS-encrypted) that the backend publishes alert e-mails to (ALERT_SNS_TOPIC_ARN),
 *  - optional e-mail subscriptions, and
 *  - least-privilege sns:Publish for the dashboard task role.
 *
 * Slack / Teams webhook URLs are secrets. Keep them in Secrets Manager (create the secrets by hand or from your pipeline,
 * never in code) and inject them into the backend container as ECS `secrets` (item 14, deploy-ecs.sh), which needs
 * secretsmanager:GetSecretValue (+ kms:Decrypt if a CMK is used) on the task EXECUTION role:
 *     SLACK_WEBHOOK_URL -> secret named by context `slackWebhookSecretName`
 *     TEAMS_WEBHOOK_URL -> secret named by context `teamsWebhookSecretName`
 * This construct only validates and outputs the secret ARNs so the task definition can reference them.
 */
export class NotificationsConstruct extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: NotificationsConstructProps) {
    super(scope, id);
    this.topic = new sns.Topic(this, 'AlertTopic', {
      topicName: 'urbani-radar-alerts',
      displayName: 'Urbani Radar alerts',
      masterKey: props.key,
    });
    for (const email of props.alertEmails) this.topic.addSubscription(new subs.EmailSubscription(email));

    // Least privilege: publish to this one topic, and use the CMK only through SNS.
    props.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ sid: 'UrbaniAlertTopicPublish', effect: iam.Effect.ALLOW, actions: ['sns:Publish'], resources: [this.topic.topicArn] }),
    );
    props.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'UrbaniAlertTopicKmsViaSns',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: [props.key.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `sns.${Stack.of(this).region}.amazonaws.com` } },
      }),
    );

    new CfnOutput(this, 'AlertTopicArn', { value: this.topic.topicArn, description: 'Set as ALERT_SNS_TOPIC_ARN on the backend' });
    const secretOutputs: Array<[string, string | undefined]> = [
      ['SlackWebhookSecretArn', props.slackWebhookSecretName],
      ['TeamsWebhookSecretArn', props.teamsWebhookSecretName],
    ];
    for (const [outputId, name] of secretOutputs) {
      if (!name) continue;
      const secret = secretsmanager.Secret.fromSecretNameV2(this, `${outputId}Ref`, name);
      new CfnOutput(this, outputId, { value: secret.secretArn, description: 'Reference as an ECS secret (item 14); value is never in code' });
    }
  }
}
