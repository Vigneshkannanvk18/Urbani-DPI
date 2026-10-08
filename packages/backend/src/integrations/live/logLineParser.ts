import { createHash } from 'node:crypto';
import type { LogEntry, LogLevel } from '@urbani/shared';

/**
 * Shared single-line log parser (Phase 3).
 *
 * The QA API exposes real log lines through TWO channels that share the exact
 * same line shape:
 *   - GET /logs/latest|history -> windows[].logs[] of {timestamp, message} (or a
 *     bare stringified JSON event).
 *   - GET /alerts/latest|history -> each alert carries an `evidence` array whose
 *     entries are EITHER a JSON-stringified log entry ({timestamp,level,message})
 *     OR a plain message string.
 *
 * Both channels are parsed HERE so the JSON-unwrap + level-inference logic lives
 * in ONE place and the Logs page can merge log-window lines with alert-evidence
 * lines without duplicating parsing or diverging on id/dedup rules.
 *
 * Everything in this module is pure (no network, no clock except an explicit
 * display fallback) so it is trivially unit-testable and deterministic.
 */

export const LOG_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

/** A mapped entry carrying its (ordering-only) sort key. */
export interface LogTuple {
  entry: LogEntry;
  sortKeyMs: number;
}

/** Context the line parser needs to stamp provenance onto an entry. */
export interface ParseLineContext {
  service: string;
  environment: string;
  /**
   * Fallback timestamp (ms) when the line itself carries no parseable one — the
   * enclosing log window_end for /logs/*, or the alert timestamp for evidence.
   */
  fallbackMs: number | undefined;
}

/**
 * Map one raw QA log line into a LogEntry + its ordering sort key.
 *
 * The input may be:
 *   - a plain string message,
 *   - a stringified JSON event {timestamp, level?, message},
 *   - an object {timestamp, message} whose message may itself be stringified JSON.
 *
 * JSON is unwrapped so the real level/message/timestamp surface; the level is
 * taken from an explicit field when present, else inferred from the message
 * text. Spanish message text is preserved verbatim.
 */
export function parseLogLine(raw: unknown, ctx: ParseLineContext): LogTuple {
  let tsRaw: unknown;
  let rawMessage: string | undefined;
  let inner: Record<string, unknown> | undefined;

  if (typeof raw === 'string') {
    inner = tryParseJson(raw);
    if (inner) {
      tsRaw = inner.timestamp;
      rawMessage = innerMessage(inner, raw);
    } else {
      rawMessage = raw;
    }
  } else {
    const o = (raw ?? {}) as { timestamp?: unknown; message?: unknown } & Record<string, unknown>;
    tsRaw = o.timestamp;
    const msgField = str(o.message);
    inner = msgField ? tryParseJson(msgField) : undefined;
    if (inner) {
      if (inner.timestamp !== undefined) tsRaw = inner.timestamp;
      rawMessage = innerMessage(inner, msgField);
    } else {
      rawMessage = msgField ?? JSON.stringify(o);
    }
  }

  const message = rawMessage ?? '';
  const parsedEntryMs = parseMs(tsRaw);
  // sortKeyMs governs ORDERING only: entry ts -> fallback (window_end/alert ts)
  // -> -Infinity (so an unparseable line sorts LAST, never first).
  const sortKeyMs = parsedEntryMs ?? ctx.fallbackMs ?? Number.NEGATIVE_INFINITY;

  // Human-facing display timestamp has its OWN fallback (ts -> fallback -> now).
  const displayMs = parsedEntryMs ?? ctx.fallbackMs ?? Date.now();
  const timestamp = new Date(displayMs).toISOString();

  const level = inner ? inferLevelWithEmbedded(inner, message) : inferLevel(message);

  const entry: LogEntry = {
    id: deterministicId(ctx.service, sortKeyMs, message),
    timestamp,
    level,
    service: ctx.service,
    environment: ctx.environment,
    message,
  };
  return { entry, sortKeyMs };
}

/** Natural key used BOTH for dedup and for the deterministic id hash. */
export function naturalKey(service: string, sortKeyMs: number, message: string): string {
  return `${service}|${sortKeyMs}|${message}`;
}

/** Deterministic, bounded id (stable across re-fetch; good React key). */
export function deterministicId(service: string, sortKeyMs: number, message: string): string {
  const shortHash = createHash('sha1')
    .update(naturalKey(service, sortKeyMs, message))
    .digest('hex')
    .slice(0, 12);
  return `${service}:${sortKeyMs}:${shortHash}`;
}

/** Stable descending sort by sortKeyMs (keeps upstream order for equal keys). */
export function stableSortDesc(tuples: LogTuple[]): LogTuple[] {
  return tuples
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.sortKeyMs - a.t.sortKeyMs || a.i - b.i)
    .map((x) => x.t);
}

/** De-duplicate tuples on the natural key; first occurrence wins. */
export function dedupeByNaturalKey(tuples: LogTuple[]): LogTuple[] {
  const byKey = new Map<string, LogTuple>();
  for (const t of tuples) {
    const key = naturalKey(t.entry.service, t.sortKeyMs, t.entry.message);
    if (!byKey.has(key)) byKey.set(key, t);
  }
  return [...byKey.values()];
}

/** Parse a string that may be a JSON object; return undefined if it isn't. */
export function tryParseJson(s: string): Record<string, unknown> | undefined {
  const t = s.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  try {
    const parsed = JSON.parse(t);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function innerMessage(inner: Record<string, unknown>, fallback: string | undefined): string {
  return str(inner.message) ?? str(inner.msg) ?? fallback ?? JSON.stringify(inner);
}

/** Level from an embedded explicit field if present, else inferred from text. */
export function inferLevelWithEmbedded(inner: Record<string, unknown>, message: string): LogLevel {
  const explicit = normalizeLevel(inner.level ?? inner.severity ?? inner.logLevel);
  return explicit ?? inferLevel(message);
}

/** Normalize an explicit level string to a LogLevel, or undefined if unknown. */
export function normalizeLevel(v: unknown): LogLevel | undefined {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  if (!s) return undefined;
  if ((LOG_LEVELS as string[]).includes(s)) return s as LogLevel;
  if (s === 'WARNING') return 'WARN';
  if (s === 'CRIT' || s === 'CRITICAL') return 'FATAL';
  if (s === 'ERR') return 'ERROR';
  if (s === 'TRACE') return 'DEBUG';
  return undefined;
}

/**
 * Infer a level from the message text (QA logs carry no level field).
 * Case-insensitive, word-boundary, priority order.
 */
export function inferLevel(message: string): LogLevel {
  const m = message;
  if (/\b(FATAL|CRITICAL)\b/i.test(m)) return 'FATAL';
  if (/\b(ERROR|ERR|EXCEPTION|FAIL|FAILED|TIMEOUT)\b/i.test(m)) return 'ERROR';
  if (/\b(WARN|WARNING)\b/i.test(m)) return 'WARN';
  if (/\b(DEBUG|TRACE)\b/i.test(m)) return 'DEBUG';
  return 'INFO';
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Parse an ISO string / epoch number to ms; undefined when unparseable. */
export function parseMs(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e12 ? v : v * 1000;
  }
  return undefined;
}
