import { randomUUID } from 'node:crypto';
import type { TypeOf, ZodTypeAny } from 'zod';
import { PersistenceError } from '../lib/errors';
import type { AuthUser, RoleRow, UserRow } from './types';

/**
 * Helpers shared by both repository drivers (DPI 2 item 1, design §4.5).
 * Nothing here touches a database.
 */

/** Legacy offset-paging clamp (§2.5-7): page >= 1, pageSize 1..200 with the given default. */
export function clampPage(
  page: number | undefined,
  pageSize: number | undefined,
  defaultSize: number,
): { page: number; pageSize: number; offset: number } {
  const p = Math.max(page ?? 1, 1);
  const size = Math.min(Math.max(pageSize ?? defaultSize, 1), 200);
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

/** SQLite BINARY collation: byte-wise comparison of the UTF-8 encodings. */
export function compareBinary(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** SQLite `LIKE '%term%'` without regex: ASCII-only case folding, `_` = one code point, `%` = any run.
 *  The `%`-separated segments are matched left to right, each at its leftmost position. Each segment has a
 *  fixed length in code points, so the leftmost placement never blocks a later segment and the result
 *  equals LIKE without backtracking. Cost per value: O(|value| · |term|) code-point comparisons. */
export function compileLike(term: string): (value: string) => boolean {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  const segments = fold(term).split('%').filter((s) => s !== '').map((s) => Array.from(s));
  const minLength = segments.reduce((n, p) => n + p.length, 0);
  return (value: string): boolean => {
    const text = Array.from(fold(value));
    if (text.length < minLength) return false;           // segments never overlap
    let pos = 0;
    for (const p of segments) {
      let hit = -1;
      for (let i = pos; hit < 0 && i + p.length <= text.length; i++) {
        let j = 0;
        while (j < p.length && (p[j] === '_' || p[j] === text[i + j])) j++;
        if (j === p.length) hit = i;
      }
      if (hit < 0) return false;
      pos = hit + p.length;
    }
    return true;
  };
}

/** `value LIKE '%term%'` for a single value. Lists compile the term once with compileLike. */
export function likeContains(value: string, term: string): boolean {
  return compileLike(term)(value);
}

const CURSOR_MAX_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Opaque list cursor: base64url JSON `{ v: 1, k: parts }`. */
export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify({ v: 1, k: parts }), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor made by encodeCursor and validates its key tuple with the list's schema
 * (validation.ts). Any failure throws PersistenceError INVALID_CURSOR, before any query runs.
 */
export function decodeCursor<S extends ZodTypeAny>(cursor: string, schema: S): TypeOf<S> {
  const invalid = () => new PersistenceError('INVALID_CURSOR', 'Invalid cursor');
  if (typeof cursor !== 'string' || cursor.length > CURSOR_MAX_LENGTH || !BASE64URL.test(cursor)) {
    throw invalid();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof decoded !== 'object' || decoded === null || (decoded as { v?: unknown }).v !== 1) {
    throw invalid();
  }
  const parsed = schema.safeParse((decoded as { k?: unknown }).k);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

let lastIdMs = 0;

/**
 * Time-ordered id: `<epoch ms zero-padded to 13>-<randomUUID>`. Strictly increasing within the
 * process: when the clock does not advance (or goes back), the previous millisecond + 1 is used.
 */
export function newTimeOrderedId(nowIso: string): string {
  const parsed = Date.parse(nowIso);
  let ms = Number.isFinite(parsed) ? parsed : Date.now();
  if (ms <= lastIdMs) ms = lastIdMs + 1;
  lastIdMs = ms;
  return `${String(ms).padStart(13, '0')}-${randomUUID()}`;
}

/** The role-name and permission parsing of DPI 1 `toAuthUser`: a missing role gives UNKNOWN and []. */
export function buildAuthUser(user: UserRow, role: RoleRow | null): AuthUser {
  let permissions: string[] = [];
  try {
    permissions = role ? (JSON.parse(role.permissions) as string[]) : [];
  } catch {
    permissions = [];
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: role?.name ?? 'UNKNOWN',
    permissions,
  };
}
