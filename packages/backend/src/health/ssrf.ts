import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF guard for the health probes (DPI 2 item 9).
 *
 * Probe URLs come ONLY from environment configuration, never from API input. Even so, a target must not be able
 * to reach cloud metadata services or, unless explicitly allowed, internal address ranges.
 *
 *  - ALWAYS blocked: link-local / metadata (169.254.0.0/16, fe80::/10, AWS IPv6 metadata fd00:ec2::/32,
 *    Alibaba 100.100.100.200), "this network" 0.0.0.0/8, multicast, reserved/broadcast.
 *  - Blocked unless HEALTH_ALLOW_PRIVATE_TARGETS=true: loopback, RFC 1918, CGNAT 100.64.0.0/10, unique-local fc00::/7.
 *
 * Checks run on the resolved IP at connect time (guarded `lookup`), so DNS rebinding and redirects to a hostname
 * that resolves into a blocked range are caught too. IP literals are checked before the request is made.
 */
const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addAddress('100.100.100.200', 'ipv4');
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6');
ALWAYS_BLOCKED.addSubnet('fd00:ec2::', 32, 'ipv6');
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6');
ALWAYS_BLOCKED.addAddress('::', 'ipv6');

const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addAddress('::1', 'ipv6');

export type AddressClass = 'blocked' | 'private' | 'public';

export class SsrfBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'SsrfBlockedError';
  }
}

/** Unwraps IPv4-mapped IPv6 (::ffff:a.b.c.d and ::ffff:xxxx:xxxx) so the IPv4 rules apply. */
function normalize(ip: string): { address: string; family: 'ipv4' | 'ipv6' } | null {
  let a = ip.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mappedDotted) a = mappedDotted[1];
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const v = isIP(a);
  if (v === 4) return { address: a, family: 'ipv4' };
  if (v === 6) return { address: a, family: 'ipv6' };
  return null;
}

export function classifyAddress(ip: string): AddressClass {
  const n = normalize(ip);
  if (!n) return 'blocked'; // not an IP: refuse rather than guess
  if (ALWAYS_BLOCKED.check(n.address, n.family)) return 'blocked';
  if (PRIVATE.check(n.address, n.family)) return 'private';
  return 'public';
}

/** null when the address may be contacted; otherwise a short, safe reason. */
export function addressBlockReason(ip: string, allowPrivate: boolean): string | null {
  const c = classifyAddress(ip);
  if (c === 'blocked') return 'blocked: link-local, metadata or reserved address';
  if (c === 'private' && !allowPrivate) return 'blocked: private address (set HEALTH_ALLOW_PRIVATE_TARGETS=true to allow internal targets)';
  return null;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Syntax-level check of a configured URL: http(s) only, no embedded credentials. */
export function parseTargetUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'only http and https URLs are allowed' };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
  if (!url.hostname) return { ok: false, reason: 'URL has no host' };
  return { ok: true, url };
}

/** Throws SsrfBlockedError when the URL's host is an IP literal in a blocked range. Hostnames are checked at connect time. */
export function assertLiteralHostAllowed(url: URL, allowPrivate: boolean): void {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const reason = addressBlockReason(host, allowPrivate);
    if (reason) throw new SsrfBlockedError(reason);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** A drop-in `lookup` for http.request that refuses to connect to blocked addresses (also covers redirect hops). */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const list = addresses as dns.LookupAddress[];
      for (const a of list) {
        const reason = addressBlockReason(a.address, allowPrivate);
        if (reason) return callback(new SsrfBlockedError(reason) as unknown as NodeJS.ErrnoException, '');
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/** Removes anything that could carry a credential from free text: URLs are reduced to scheme://host. */
export function redactText(text: string, maxLength = 200): string {
  const out = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi, (m) => {
    try {
      const u = new URL(m);
      return `${u.protocol}//${u.hostname}`;
    } catch {
      return '[url]';
    }
  });
  return out.length > maxLength ? `${out.slice(0, maxLength)}...` : out;
}

/** A URL safe to log: scheme, host and port only. No path, query string or credentials. */
export function safeUrlLabel(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[invalid url]';
  }
}
