import { describe, expect, it, beforeAll } from 'vitest';
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import { SnsEmailChannel } from './channels';
import { testMessage } from './message';

/**
 * E-mail (SNS) channel against a LOCAL SNS emulator, through the real AWS SDK (no mocks).
 * Skipped unless SNS_ENDPOINT is set, e.g. a moto server:
 *   docker run --rm -p 5000:5000 motoserver/moto:latest
 *   SNS_ENDPOINT=http://127.0.0.1:5000 npm test --workspace @urbani/backend
 * This proves the SDK calls (Publish, GetTopicAttributes), ARN handling and error paths. It does NOT prove delivery
 * to a real mailbox: that needs a real AWS topic with a confirmed subscriber.
 */
const endpoint = process.env.SNS_ENDPOINT;

describe.skipIf(!endpoint)('SnsEmailChannel against a local SNS emulator', { timeout: 20_000 }, () => {
  const client = new SNSClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  let topicArn = '';

  beforeAll(async () => {
    const topic = await client.send(new CreateTopicCommand({ Name: `urbani-radar-alerts-${Date.now()}` }));
    topicArn = topic.TopicArn as string;
    await client.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: 'email', Endpoint: 'oncall@example.com' }));
  });

  it('checkConnection reaches the topic, reports subscribers and never returns the ARN', async () => {
    const r = await new SnsEmailChannel(topicArn, client).checkConnection();
    expect(r.ok).toBe(true);
    expect(r.topicName).toBe(topicArn.split(':').pop());
    // moto creates the subscription but never fills SubscriptionsConfirmed / SubscriptionsPending (always "0"), so only
    // the shape is asserted here. Real AWS reports the actual counts; the logic on them is covered by channels.test.ts.
    expect(typeof r.subscriptionsConfirmed).toBe('number');
    expect(typeof r.subscriptionsPending).toBe('number');
    expect(JSON.stringify(r)).not.toContain(topicArn);
  });

  it('publishes the alert e-mail and returns a MessageId', async () => {
    const res = await new SnsEmailChannel(topicArn, client).send(testMessage('CRITICAL', 'https://dash.example.com', new Date().toISOString()));
    expect(res.attempts).toBe(1);
    expect(res.providerMessageId).toBeTruthy();
  });

  it('checkConnection reports a clear failure for a topic that does not exist', async () => {
    const missing = topicArn.replace(/:[^:]+$/, ':does-not-exist');
    const r = await new SnsEmailChannel(missing, client).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(missing);
  });
});
