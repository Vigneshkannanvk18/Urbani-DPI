import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Per-request audit context (DPI 2 item 3): who (id, email, role), from where (IP) and which request
 * (correlation id). Set by middleware, read by the audit writer. Outside a request it is empty.
 */
export interface AuditRequestContext {
  userId?: string;
  email?: string;
  role?: string;
  ip?: string;
  requestId?: string;
}

const store = new AsyncLocalStorage<AuditRequestContext>();

/** Express middleware: opens the context (mount after correlationId). */
export function auditRequestContext(req: Request, _res: Response, next: NextFunction): void {
  store.run({ ip: req.ip, requestId: req.correlationId }, next);
}

/** Fill in the authenticated actor (called by requireAuth and by login). */
export function setAuditActor(actor: { userId: string; email: string; role: string }): void {
  const ctx = store.getStore();
  if (ctx) Object.assign(ctx, actor);
}

const SECRET_KEY = /(password|passwd|token|authorization|api[-_]?key|secret|cookie|totp|recovery|passcode|verifier)/i;
export const REDACTED = '[REDACTED]';

/** Central redaction: any key that looks like a secret has its value replaced, at any depth. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out as T;
}

/** Metadata as stored: redacted caller fields plus the request context under `ctx`. Null if both empty. */
export function buildAuditMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | null {
  const base = metadata ? redact(metadata) : {};
  const c = store.getStore();
  const ctx = c
    ? Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null && v !== ''))
    : {};
  const merged = Object.keys(ctx).length ? { ...base, ctx } : base;
  return Object.keys(merged).length || metadata ? merged : null;
}

/** First chars of a free-text question, for the audit preview (never the answer). */
export function preview(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Best-effort redaction of secrets typed into FREE TEXT (e.g. a feedback comment): `key=value` / `key: value`
 * pairs whose key looks like a secret, bearer tokens and AWS access key ids. Reuses the key pattern of redact().
 */
export function redactText(text: string): string {
  return text
    .replace(new RegExp(`\\b(${SECRET_KEY.source.slice(1, -1)})\\w*\\s*[:=]\\s*\\S+`, 'gi'), (_m, k: string) => `${k}=${REDACTED}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED);
}
