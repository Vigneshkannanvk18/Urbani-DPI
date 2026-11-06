import { z } from 'zod';
import type { LogSearchApplied } from '@urbani/shared';
import { assertSafeRegex } from './safeRegex';

/**
 * GET /api/logs query contract (DPI 2 item 4). Backward compatible with the original
 * params (service, level, search, page, pageSize, environment).
 *
 *   levels=ERROR,WARN (or repeated)   services=main,payments   from / to (ISO 8601 date-time)
 *   search=<text>  (alias: text)      regex=true  -> `search` is a regular expression
 *   sort=newest|oldest                page / pageSize
 */
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

const listParam = (v: unknown): unknown => {
  if (v === undefined) return undefined;
  const raw = Array.isArray(v) ? v : [v];
  const out = raw.flatMap((x) => (typeof x === 'string' ? x.split(',') : [x])).map((x) => (typeof x === 'string' ? x.trim() : x));
  return out.filter((x) => x !== '');
};

const boolParam = (v: unknown): unknown => {
  if (v === undefined || v === '') return undefined;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.toLowerCase()) ? true : ['false', '0', 'no', 'off'].includes(v.toLowerCase()) ? false : v;
  return v;
};

const emptyToUndef = (v: unknown): unknown => (v === '' ? undefined : v);

export const logQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
    service: z.preprocess(emptyToUndef, z.string().max(64).optional()),
    environment: z.preprocess(emptyToUndef, z.string().max(64).optional()),
    level: z.preprocess(emptyToUndef, z.enum(LOG_LEVELS).optional()),
    levels: z.preprocess(listParam, z.array(z.enum(LOG_LEVELS)).max(5).optional()),
    services: z.preprocess(listParam, z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'invalid service name')).max(20).optional()),
    search: z.preprocess(emptyToUndef, z.string().max(1000).optional()),
    text: z.preprocess(emptyToUndef, z.string().max(1000).optional()),
    regex: z.preprocess(boolParam, z.boolean().optional()),
    from: z.preprocess(emptyToUndef, z.string().datetime({ offset: true, message: 'from must be an ISO 8601 date-time' }).optional()),
    to: z.preprocess(emptyToUndef, z.string().datetime({ offset: true, message: 'to must be an ISO 8601 date-time' }).optional()),
    sort: z.preprocess(emptyToUndef, z.enum(['newest', 'oldest']).optional()),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), {
    message: 'from must not be after to',
    path: ['from'],
  });

export type LogQueryParams = z.infer<typeof logQuerySchema>;

/** Normalised search the service/adapters work with. */
export interface LogSearch {
  service?: string;
  environment?: string;
  /** Legacy single level (kept so audit metadata and old callers stay unchanged). */
  level?: string;
  levels: string[];
  services: string[];
  search?: string;
  regex: boolean;
  from?: string;
  to?: string;
  sort: 'newest' | 'oldest';
  page?: number;
  pageSize?: number;
}

/** Parse + validate (throws ZodError / ValidationError -> 400). */
export function parseLogSearch(query: unknown, regexMaxLength: number): LogSearch {
  const q = logQuerySchema.parse(query);
  const search = q.search ?? q.text;
  const regex = q.regex === true;
  if (regex && search) assertSafeRegex(search, regexMaxLength);
  const levels = [...new Set([...(q.levels ?? []), ...(q.level ? [q.level] : [])])];
  const services = [...new Set([...(q.services ?? []), ...(q.service ? [q.service] : [])])];
  return {
    service: q.service,
    environment: q.environment,
    level: q.level,
    levels,
    services,
    search,
    regex: regex && !!search,
    from: q.from,
    to: q.to,
    sort: q.sort ?? 'newest',
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** Filter parameters only (never log content) — used for the audit event and the response meta. */
export function appliedFilters(s: LogSearch): LogSearchApplied {
  const a: LogSearchApplied = {};
  if (s.levels.length) a.levels = s.levels;
  if (s.services.length) a.services = s.services;
  if (s.from) a.from = s.from;
  if (s.to) a.to = s.to;
  if (s.search) a.search = s.search;
  if (s.regex) a.regex = true;
  return a;
}
