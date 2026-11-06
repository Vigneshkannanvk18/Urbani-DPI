import { describe, expect, it } from 'vitest';
import { buildAllowList, hostMatches, maskHost, redactText, validateWebhookUrl } from './guard';

const allow = buildAllowList(null);

describe('webhook URL guard (SSRF)', () => {
  it('accepts the default provider hosts over https', () => {
    for (const url of [
      'https://hooks.slack.com/services/T000/B000/XXXX',
      'https://contoso.webhook.office.com/webhookb2/abc',
      'https://prod-12.westus.logic.azure.com:443/workflows/abc',
      'https://abc.12.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x',
    ]) {
      expect(validateWebhookUrl(url, allow).ok, url).toBe(true);
    }
  });

  it('rejects http, other hosts, look-alikes, credentials, ports and junk', () => {
    for (const url of [
      'http://hooks.slack.com/services/x',
      'https://evil.example.com/hook',
      'https://hooks.slack.com.evil.com/x',
      'https://evilhooks.slack.com/x',
      'https://webhook.office.com/x', // wildcard needs a sub-domain
      'https://user:pw@hooks.slack.com/x',
      'https://hooks.slack.com:8443/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/hook',
      'not a url',
      '',
    ]) {
      expect(validateWebhookUrl(url, allow).ok, url).toBe(false);
    }
  });

  it('can be extended through NOTIFICATIONS_WEBHOOK_HOST_ALLOWLIST', () => {
    const extended = buildAllowList('hooks.example.org, *.chat.example.org');
    expect(validateWebhookUrl('https://hooks.example.org/x', extended).ok).toBe(true);
    expect(validateWebhookUrl('https://a.chat.example.org/x', extended).ok).toBe(true);
    expect(validateWebhookUrl('https://hooks.example.org/x', allow).ok).toBe(false);
  });

  it('never echoes the URL in the rejection reason', () => {
    const r = validateWebhookUrl('https://evil.example.com/secret-token', allow);
    expect(JSON.stringify(r)).not.toContain('secret-token');
  });

  it('matches wildcard hosts only with at least one label', () => {
    expect(hostMatches('a.webhook.office.com', '*.webhook.office.com')).toBe(true);
    expect(hostMatches('webhook.office.com', '*.webhook.office.com')).toBe(false);
  });

  it('masks the leftmost label and redacts URLs from text', () => {
    expect(maskHost('contoso.webhook.office.com')).toBe('***.webhook.office.com');
    expect(maskHost('hooks.slack.com')).toBe('hooks.slack.com');
    const out = redactText('connect failed to https://hooks.slack.com/services/T/B/SECRET: boom', ['SECRET']);
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('hooks.slack.com');
  });
});
