import { z } from 'zod';
import {
  AUDIT_RESULTS,
  CHAT_MESSAGE_ROLES,
  CHAT_RATINGS,
  DATA_SOURCES,
  THEMES,
  USER_ROLES,
} from '@urbani/shared';
import type { AuditResult, ChatMessageRole, DataSource, Theme, UserRole } from '@urbani/shared';
import { PersistenceError } from '../lib/errors';
import { compareBinary } from './common';
import type {
  AuditRangeQuery,
  ChatFeedbackInput,
  NewChatMessage,
  NewChatSession,
  PreferencesPatch,
} from './types';

/**
 * Validation of repository inputs for the DPI 2 entities (design §7.3), shared by both drivers.
 * Every parse* helper throws PersistenceError INVALID_ARGUMENT with the zod issues of the caller's
 * own input. Legacy methods get no new validation.
 */

function parseWith<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const res = schema.safeParse(input);
  if (!res.success) {
    throw new PersistenceError('INVALID_ARGUMENT', 'Invalid argument', { details: res.error.issues });
  }
  return res.data;
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const maxUtf8 = (max: number) => (s: string) => utf8Bytes(s) <= max;

/** A canonical timestamp is exactly what new Date(ts).toISOString() prints. */
function isCanonicalIso(ts: string): boolean {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && new Date(ms).toISOString() === ts;
}

/** Ids taken by the read methods and the new entities: 1–128 characters. */
const readIdSchema = z.string().min(1).max(128);
/** Ids that end up inside sort keys and cursors. */
const safeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'letters, digits, _ and - only (1-128)');
const canonicalTsSchema = z.string().datetime().refine(isCanonicalIso, 'must be a canonical ISO-8601 timestamp');

// ---- Users, audit ----

const userRoleSchema = z.enum(USER_ROLES);
const auditResultSchema = z.enum(AUDIT_RESULTS);

/** UserUpsert.role: optional; omitted (or null) gives null, which the drivers treat as "default / keep". */
export function parseUserRole(role?: UserRole | null): UserRole | null {
  if (role === undefined || role === null) return null;
  return parseWith(userRoleSchema, role);
}

/** record(…, result): optional, default SUCCESS. */
export function parseAuditResult(result?: AuditResult): AuditResult {
  if (result === undefined) return 'SUCCESS';
  return parseWith(auditResultSchema, result);
}

const isoInstantSchema = z
  .string()
  .datetime({ offset: true })
  .refine((s) => Number.isFinite(Date.parse(s)), 'must be a valid date')
  .transform((s) => new Date(s).toISOString());

const auditRangeQuerySchema = z
  .object({
    from: isoInstantSchema.optional(),
    to: isoInstantSchema.optional(),
    actor: z.string().min(1).max(320).optional(),
    actions: z.array(z.string().min(1).max(64)).max(64).optional(),
    result: auditResultSchema.optional(),
    text: z.string().min(1).max(200).optional(),
    metadataContains: z.string().min(1).max(200).optional(),
    limit: z.number().int().optional(),
    cursor: z.string().optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || compareBinary(q.from, q.to) <= 0, {
    message: 'from must not be after to',
    path: ['from'],
  });

export interface ParsedAuditRangeQuery {
  /** Normalised with new Date(x).toISOString(); null = unbounded. */
  from: string | null;
  to: string | null;
  actor: string | null;
  actions: string[] | null;
  result: AuditResult | null;
  /** Lower-cased. */
  text: string | null;
  metadataContains: string | null;
  /** Clamped to 1..200, default 50. */
  limit: number;
  /** Still encoded: decode with decodeCursor(cursor, auditCursorSchema(from, to)) before querying. */
  cursor: string | undefined;
}

export function parseAuditRangeQuery(opts: AuditRangeQuery): ParsedAuditRangeQuery {
  const q = parseWith(auditRangeQuerySchema, opts ?? {});
  return {
    from: q.from ?? null,
    to: q.to ?? null,
    actor: q.actor ?? null,
    actions: q.actions ?? null,
    result: q.result ?? null,
    text: q.text ? q.text.toLowerCase() : null,
    metadataContains: q.metadataContains ?? null,
    limit: Math.min(Math.max(q.limit ?? 50, 1), 200),
    cursor: q.cursor,
  };
}

// ---- Preferences ----

const WIDGET_LAYOUT_MAX_BYTES = 16_384;

const preferencesPatchSchema = z.object({
  userId: readIdSchema,
  patch: z
    .object({
      theme: z.enum(THEMES).nullable().optional(),
      widgetLayout: z.unknown().superRefine((v, ctx) => {
        if (v === undefined || v === null) return;
        let json: unknown;
        try {
          json = JSON.stringify(v);
        } catch {
          json = undefined;
        }
        if (typeof json !== 'string') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'widgetLayout must be JSON-serializable' });
        } else if (utf8Bytes(json) > WIDGET_LAYOUT_MAX_BYTES) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `widgetLayout must serialize to at most ${WIDGET_LAYOUT_MAX_BYTES} bytes`,
          });
        }
      }),
    })
    .refine((p) => p.theme !== undefined || p.widgetLayout !== undefined, {
      message: 'patch must set theme or widgetLayout',
    }),
});

export interface ParsedPreferencesPatch {
  userId: string;
  /** undefined = keep, null = clear. */
  theme?: Theme | null;
  /** undefined = keep, null = clear; otherwise a JSON-serializable value of at most 16,384 bytes. */
  widgetLayout?: unknown;
}

export function parsePreferencesPatch(userId: string, patch: PreferencesPatch): ParsedPreferencesPatch {
  const p = parseWith(preferencesPatchSchema, { userId, patch });
  const out: ParsedPreferencesPatch = { userId: p.userId };
  if (p.patch.theme !== undefined) out.theme = p.patch.theme;
  if (p.patch.widgetLayout !== undefined) out.widgetLayout = p.patch.widgetLayout;
  return out;
}

// ---- Chat ----

const newChatSessionSchema = z.object({
  id: safeIdSchema.optional(),
  userId: readIdSchema,
  title: z.string().max(200).nullable().optional(),
  service: z.string().max(64).nullable().optional(),
  environment: z.string().max(64).nullable().optional(),
});

export interface ParsedNewChatSession {
  /** undefined: the driver generates one. */
  id: string | undefined;
  userId: string;
  title: string | null;
  service: string | null;
  environment: string | null;
}

export function parseNewChatSession(input: NewChatSession): ParsedNewChatSession {
  const s = parseWith(newChatSessionSchema, input);
  return {
    id: s.id,
    userId: s.userId,
    title: s.title ?? null,
    service: s.service ?? null,
    environment: s.environment ?? null,
  };
}

const newChatMessageSchema = z.object({
  sessionId: readIdSchema,
  role: z.enum(CHAT_MESSAGE_ROLES),
  content: z.string().min(1).refine(maxUtf8(65_536), 'content must be at most 65536 bytes'),
  citations: z
    .array(z.string().refine(maxUtf8(4_096), 'a citation must be at most 4096 bytes'))
    .max(50)
    .optional(),
  provider: z.string().max(128).nullable().optional(),
  modelId: z.string().max(128).nullable().optional(),
  source: z.enum(DATA_SOURCES).nullable().optional(),
  latencyMs: z.number().int().min(0).max(600_000).nullable().optional(),
  inputTokens: z.number().int().min(0).nullable().optional(),
  outputTokens: z.number().int().min(0).nullable().optional(),
});

export interface ParsedNewChatMessage {
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  citations: string[];
  provider: string | null;
  modelId: string | null;
  source: DataSource | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function parseNewChatMessage(input: NewChatMessage): ParsedNewChatMessage {
  const m = parseWith(newChatMessageSchema, input);
  return {
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    citations: m.citations ?? [],
    provider: m.provider ?? null,
    modelId: m.modelId ?? null,
    source: m.source ?? null,
    latencyMs: m.latencyMs ?? null,
    inputTokens: m.inputTokens ?? null,
    outputTokens: m.outputTokens ?? null,
  };
}

const chatFeedbackInputSchema = z.object({
  sessionId: readIdSchema,
  messageId: readIdSchema,
  userId: readIdSchema,
  rating: z.enum(CHAT_RATINGS),
  comment: z.string().max(2_000).nullable().optional(),
});

export type ParsedChatFeedbackInput = Omit<ChatFeedbackInput, 'comment'> & { comment: string | null };

export function parseChatFeedbackInput(input: ChatFeedbackInput): ParsedChatFeedbackInput {
  const f = parseWith(chatFeedbackInputSchema, input);
  return { ...f, comment: f.comment ?? null };
}

/** preferences.get, getSession, listSessionsByUser, listMessages, listFeedback: 1–128 characters. */
export function parseReadId(id: string): string {
  return parseWith(readIdSchema, id);
}

function clampLimit(limit: number | undefined, def: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return def;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/** listSessionsByUser limit: 1..100, default 20; clamped, never rejected. */
export function clampSessionLimit(limit?: number): number {
  return clampLimit(limit, 20, 100);
}

/** listMessages limit: 1..500, default 200; clamped, never rejected. */
export function clampMessageLimit(limit?: number): number {
  return clampLimit(limit, 200, 500);
}

// ---- Cursor key tuples (decoded by decodeCursor in common.ts) ----

/** Audit `[ts, id]`: canonical ts inside the inclusive [from, to] range (compareBinary); id 1–64 characters. */
export function auditCursorSchema(from?: string | null, to?: string | null) {
  return z
    .tuple([canonicalTsSchema, z.string().min(1).max(64)])
    .refine(
      ([ts]) => (from == null || compareBinary(from, ts) <= 0) && (to == null || compareBinary(ts, to) <= 0),
      'cursor outside the requested range',
    );
}

/** Sessions `[updatedAt, id]`. */
export const sessionCursorSchema = z.tuple([canonicalTsSchema, safeIdSchema]);

/** Messages `[id]`. */
export const messageCursorSchema = z.tuple([safeIdSchema]);
