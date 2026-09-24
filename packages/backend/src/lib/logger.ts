import { config } from '../config';

/**
 * Minimal structured JSON logger (Task 1.4).
 *
 * Emits one JSON object per line — friendly for CloudWatch Logs ingestion in
 * Phase 2. No external logging dependency to keep the foundation lean.
 *
 * SECURITY: callers must not pass secrets/tokens/PII in log fields. Reference
 * secrets by key name, never by value.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel];

function write(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    app: config.appName,
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Returns a child logger that always attaches the given context (e.g. correlationId). */
  child(context: Record<string, unknown>): Logger;
}

function makeLogger(base: Record<string, unknown>): Logger {
  return {
    debug: (m, meta) => write('debug', m, { ...base, ...meta }),
    info: (m, meta) => write('info', m, { ...base, ...meta }),
    warn: (m, meta) => write('warn', m, { ...base, ...meta }),
    error: (m, meta) => write('error', m, { ...base, ...meta }),
    child: (ctx) => makeLogger({ ...base, ...ctx }),
  };
}

export const logger = makeLogger({});
