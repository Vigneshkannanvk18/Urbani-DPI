/**
 * Webhook URL guard (SSRF) and redaction helpers (DPI 2 item 6).
 * A webhook URL is a secret: it must never reach a log line, an audit event, an API response or the delivery log.
 */

export const DEFAULT_WEBHOOK_HOST_PATTERNS = [
  'hooks.slack.com',
  '*.webhook.office.com',
  '*.logic.azure.com',
  '*.environment.api.powerplatform.com',
];

export type UrlCheck = { ok: true; host: string } | { ok: false; reason: string };

/** `*.example.com` matches any sub-domain (at least one label) of example.com, never example.com itself. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.length > suffix.length && h.endsWith(suffix);
  }
  return h === p;
}

/** Parses a comma-separated allow-list extension and appends it to the defaults. */
export function buildAllowList(extra: string | null | undefined): string[] {
  const more = (extra ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_WEBHOOK_HOST_PATTERNS, ...more];
}

/** Must be https, have a host on the allow-list, no credentials and no non-default port. Never echoes the URL. */
export function validateWebhookUrl(raw: string | null | undefined, allowList: string[]): UrlCheck {
  if (!raw) return { ok: false, reason: 'not set' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'must use https' };
  if (u.username || u.password) return { ok: false, reason: 'must not contain credentials' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'custom ports are not allowed' };
  if (!allowList.some((p) => hostMatches(u.hostname, p))) return { ok: false, reason: 'host is not on the allow-list' };
  return { ok: true, host: u.hostname.toLowerCase() };
}

/** "abc.webhook.office.com" -> "***.webhook.office.com"; the leftmost label may identify the tenant. */
export function maskHost(host: string): string {
  const parts = host.split('.');
  return parts.length > 3 ? `***.${parts.slice(1).join('.')}` : host;
}

/** Removes every URL (and the given secrets) from free text such as error messages. */
export function redactText(text: string, secrets: Array<string | null | undefined> = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted-url]');
  return out.replace(/https?:\/\/[^\s"'<>)]+/gi, '[redacted-url]').slice(0, 500);
}
