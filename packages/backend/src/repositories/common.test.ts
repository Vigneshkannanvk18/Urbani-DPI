import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { PersistenceError } from '../lib/errors';
import {
  clampPage,
  compareBinary,
  compileLike,
  decodeCursor,
  encodeCursor,
  likeContains,
  newTimeOrderedId,
} from './common';
import { auditCursorSchema, messageCursorSchema, sessionCursorSchema } from './validation';

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectInvalidCursor(fn: () => unknown): void {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PersistenceError);
  expect((err as PersistenceError).reason).toBe('INVALID_CURSOR');
}

describe('compileLike / likeContains', () => {
  let db: Database.Database;
  let sqliteLike: (value: string, term: string) => boolean;

  beforeAll(() => {
    db = new Database(':memory:');
    const stmt = db.prepare('SELECT ? LIKE ? AS m');
    sqliteLike = (value, term) => (stmt.get(value, `%${term}%`) as { m: number }).m === 1;
  });
  afterAll(() => db.close());

  it('folds ASCII case only', () => {
    expect(likeContains('Connection RESET', 'connection reset')).toBe(true);
    expect(likeContains('connection reset', 'CONNECTION RESET')).toBe(true);
    expect(likeContains('café', 'CAFÉ')).toBe(false);
    expect(likeContains('CAFÉ', 'café')).toBe(false);
    expect(likeContains('café', 'CAFé')).toBe(true);
  });

  it('_ matches exactly one code point, including an astral emoji', () => {
    expect(likeContains('a😀b', 'a_b')).toBe(true);
    expect(likeContains('a😀b', 'a__b')).toBe(false);
    expect(likeContains('ab', 'a_b')).toBe(false);
    expect(likeContains('axb', 'a_b')).toBe(true);
    expect(likeContains('😀', '_')).toBe(true);
    expect(likeContains('', '_')).toBe(false);
  });

  it('% matches any run, including an empty one', () => {
    expect(likeContains('connection pool exhausted', 'connection%exhausted')).toBe(true);
    expect(likeContains('connectionexhausted', 'connection%exhausted')).toBe(true);
    expect(likeContains('exhausted connection', 'connection%exhausted')).toBe(false);
    expect(likeContains('anything', '%')).toBe(true);
    expect(likeContains('', '')).toBe(true);
    expect(likeContains('', '%%')).toBe(true);
  });

  it('treats regex metacharacters literally', () => {
    expect(likeContains('price is $5 (approx.)', '$5 (approx.)')).toBe(true);
    expect(likeContains('a.c', 'a.c')).toBe(true);
    expect(likeContains('abc', 'a.c')).toBe(false);
    expect(likeContains('a*b+c?', '*b+c?')).toBe(true);
    expect(likeContains('aaab', 'a*b')).toBe(false);
    expect(likeContains('[x]^|\\', '[x]^|\\')).toBe(true);
    expect(likeContains('x', '[x]')).toBe(false);
  });

  it('compileLike reuses one compiled term across values', () => {
    const match = compileLike('po_l');
    expect(['pool', 'POOL party', 'spoil', 'pol', 'plop'].map(match)).toEqual([true, true, true, false, false]);
  });

  it('agrees with SQLite LIKE on a fixed table', () => {
    const table: Array<[string, string]> = [
      ['DB connection pool exhausted', 'POOL'],
      ['DB connection pool exhausted', 'po_l'],
      ['DB connection pool exhausted', 'po__l'],
      ['DB connection pool exhausted', 'db%pool'],
      ['DB connection pool exhausted', 'pool%db'],
      ['café', 'CAFÉ'],
      ['CAFÉ', 'CAFÉ'],
      ['ÉCOLE', 'école'],
      ['a😀b', 'a_b'],
      ['a😀b', 'a__b'],
      ['a😀😀b', '😀_b'],
      ['', ''],
      ['', '_'],
      ['abc', ''],
      ['abc', '%'],
      ['abc', '%%%'],
      ['abc', '_%_%_'],
      ['abc', '_%_%_%_'],
      ['a.c', 'a.c'],
      ['abc', 'a.c'],
      ['(x)', '(x)'],
      ['[x]', '[x]'],
      ['x', '[x]'],
      ['$^', '$^'],
      ['a\\b', 'a\\b'],
      ['Ünïcode', 'ünïcode'],
      ['ZZZ', 'zz'],
      ['the eerie needle', 'e_e'],
      ['mississippi', 'iss%ipp'],
      ['mississippi', 'ss_ss'],
    ];
    for (const [value, term] of table) {
      expect([value, term, likeContains(value, term)]).toEqual([value, term, sqliteLike(value, term)]);
    }
  });

  it('agrees with SQLite LIKE on 2,000 deterministic pseudo-random pairs', () => {
    const next = rng(20261001);
    const valueAlphabet = ['a', 'A', 'b', 'B', 'e', 'E', ' ', '.', '*', '(', '$', '\\', 'é', 'É', '😀', '_', '%'];
    const termAlphabet = ['a', 'A', 'b', 'B', 'e', 'E', ' ', '.', '*', '(', '$', '\\', 'é', 'É', '😀', '_', '%', '_', '%'];
    const pick = (alphabet: string[], max: number): string => {
      const n = Math.floor(next() * (max + 1));
      let s = '';
      for (let i = 0; i < n; i++) s += alphabet[Math.floor(next() * alphabet.length)];
      return s;
    };
    let matches = 0;
    const mismatches: Array<[string, string]> = [];
    for (let i = 0; i < 2000; i++) {
      const value = pick(valueAlphabet, 12);
      const term = pick(termAlphabet, 4);
      const expected = sqliteLike(value, term);
      if (expected) matches++;
      if (likeContains(value, term) !== expected) mismatches.push([value, term]);
    }
    expect(mismatches).toEqual([]);
    // The generator must exercise both outcomes.
    expect(matches).toBeGreaterThan(200);
    expect(matches).toBeLessThan(1800);
  });

  it('returns false for a pathological term in under 50 ms (no backtracking)', () => {
    const value = 'the eerie needle seems free here, see every green tree. '.repeat(4);
    const start = performance.now();
    const result = likeContains(value, '%e%e%e%e%e%e%e%e%z');
    const elapsed = performance.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(50);
    expect(sqliteLike(value, '%e%e%e%e%e%e%e%e%z')).toBe(false);
  });
});

describe('compareBinary', () => {
  it('orders by UTF-8 bytes, like SQLite BINARY', () => {
    expect(compareBinary('a', 'b')).toBeLessThan(0);
    expect(compareBinary('b', 'a')).toBeGreaterThan(0);
    expect(compareBinary('abc', 'abc')).toBe(0);
    expect(compareBinary('B', 'a')).toBeLessThan(0);
    expect(compareBinary('ab', 'abc')).toBeLessThan(0);
    // UTF-16 order puts the surrogate pair first; UTF-8 byte order does not.
    expect('\uFF61' < '😀').toBe(false);
    expect(compareBinary('\uFF61', '😀')).toBeLessThan(0);
  });

  it('agrees with SQLite comparisons', () => {
    const db = new Database(':memory:');
    try {
      const stmt = db.prepare('SELECT (? < ?) AS lt, (? = ?) AS eq');
      const values = ['', 'a', 'A', 'b', 'é', 'É', '\uFF61', '😀', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00Z'];
      for (const x of values) {
        for (const y of values) {
          const r = stmt.get(x, y, x, y) as { lt: number; eq: number };
          const c = compareBinary(x, y);
          expect([x, y, c < 0, c === 0]).toEqual([x, y, r.lt === 1, r.eq === 1]);
        }
      }
    } finally {
      db.close();
    }
  });
});

describe('clampPage', () => {
  it('defaults and clamps page and pageSize', () => {
    expect(clampPage(undefined, undefined, 25)).toEqual({ page: 1, pageSize: 25, offset: 0 });
    expect(clampPage(0, 0, 25)).toEqual({ page: 1, pageSize: 1, offset: 0 });
    expect(clampPage(-2, -5, 50)).toEqual({ page: 1, pageSize: 1, offset: 0 });
    expect(clampPage(3, 500, 25)).toEqual({ page: 3, pageSize: 200, offset: 400 });
    expect(clampPage(2, 10, 50)).toEqual({ page: 2, pageSize: 10, offset: 10 });
  });
});

describe('cursor codec', () => {
  const pair = z.tuple([z.string(), z.string()]);

  it('round-trips a key tuple', () => {
    const parts = ['2026-10-01T00:00:00.000Z', 'id-ü-😀'];
    const cursor = encodeCursor(parts);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, pair)).toEqual(parts);
  });

  it('rejects garbage with INVALID_CURSOR', () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    expectInvalidCursor(() => decodeCursor('', pair));
    expectInvalidCursor(() => decodeCursor('not a cursor!', pair));
    expectInvalidCursor(() => decodeCursor('a'.repeat(1025), pair));
    expectInvalidCursor(() => decodeCursor(b64('not json'), pair));
    expectInvalidCursor(() => decodeCursor(b64('null'), pair));
    expectInvalidCursor(() => decodeCursor(b64('[1,2]'), pair));
    expectInvalidCursor(() => decodeCursor(b64('{"v":2,"k":["a","b"]}'), pair));
    expectInvalidCursor(() => decodeCursor(b64('{"v":1}'), pair));
    expectInvalidCursor(() => decodeCursor(b64('{"v":1,"k":["a"]}'), pair));
    expectInvalidCursor(() => decodeCursor(b64('{"v":1,"k":["a",2]}'), pair));
    expectInvalidCursor(() => decodeCursor(undefined as unknown as string, pair));
  });
});

describe('cursor schemas', () => {
  const from = '2026-10-01T00:00:01.000Z';
  const to = '2026-10-01T00:00:03.000Z';

  it('auditCursorSchema checks the range, canonical timestamps and the id length', () => {
    const decode = (parts: unknown[], f?: string | null, t?: string | null) =>
      decodeCursor(encodeCursor(parts as string[]), auditCursorSchema(f, t));
    expect(decode([from, 'id-1'], from, to)).toEqual([from, 'id-1']);
    expect(decode([to, 'id-1'], from, to)).toEqual([to, 'id-1']);
    expect(decode(['2026-10-01T00:00:02.000Z', 'id'], from, to)).toEqual(['2026-10-01T00:00:02.000Z', 'id']);
    expect(decode(['2030-01-01T00:00:00.000Z', 'id'])).toEqual(['2030-01-01T00:00:00.000Z', 'id']);
    expect(decode(['2030-01-01T00:00:00.000Z', 'id'], null, null)).toEqual(['2030-01-01T00:00:00.000Z', 'id']);
    expectInvalidCursor(() => decode(['2026-10-01T00:00:00.999Z', 'id'], from, to));
    expectInvalidCursor(() => decode(['2026-10-01T00:00:03.001Z', 'id'], from, to));
    expectInvalidCursor(() => decode(['2026-10-01T00:00:00Z', 'id']));
    expectInvalidCursor(() => decode(['2026-10-01T00:00:00.000+00:00', 'id']));
    expectInvalidCursor(() => decode(['not a date', 'id']));
    expectInvalidCursor(() => decode([from, '']));
    expectInvalidCursor(() => decode([from, 'x'.repeat(65)]));
    expect(decode([from, 'x'.repeat(64)])).toEqual([from, 'x'.repeat(64)]);
    expectInvalidCursor(() => decode([from]));
  });

  it('sessionCursorSchema takes a canonical timestamp and a safe id', () => {
    const decode = (parts: unknown[]) => decodeCursor(encodeCursor(parts as string[]), sessionCursorSchema);
    expect(decode([from, 'sess_1-A'])).toEqual([from, 'sess_1-A']);
    expectInvalidCursor(() => decode(['2026-10-01T00:00:01Z', 'sess-1']));
    expectInvalidCursor(() => decode([from, 'sess/1']));
    expectInvalidCursor(() => decode([from, '']));
    expectInvalidCursor(() => decode([from, 'x'.repeat(129)]));
    expect(decode([from, 'x'.repeat(128)])).toEqual([from, 'x'.repeat(128)]);
  });

  it('messageCursorSchema takes one safe id', () => {
    const decode = (parts: unknown[]) => decodeCursor(encodeCursor(parts as string[]), messageCursorSchema);
    const id = '1790812800000-6f1c2b9e-1d3a-4e5f-8a9b-0c1d2e3f4a5b';
    expect(decode([id])).toEqual([id]);
    expectInvalidCursor(() => decode([]));
    expectInvalidCursor(() => decode(['']));
    expectInvalidCursor(() => decode(['bad id']));
    expectInvalidCursor(() => decode([id, 'extra']));
    expectInvalidCursor(() => decode(['x'.repeat(129)]));
  });
});

describe('newTimeOrderedId', () => {
  it('is strictly increasing under a frozen clock', () => {
    const frozen = '2026-10-01T00:00:00.000Z';
    const ids = Array.from({ length: 100 }, () => newTimeOrderedId(frozen));
    for (const id of ids) expect(id).toMatch(/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    for (let i = 1; i < ids.length; i++) expect(ids[i - 1] < ids[i]).toBe(true);
    expect(Number(ids[0].slice(0, 13))).toBeGreaterThanOrEqual(Date.parse(frozen));
    expect(new Set(ids).size).toBe(100);
  });
});
