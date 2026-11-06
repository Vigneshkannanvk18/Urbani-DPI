import { describe, it, expect } from 'vitest';
import { regexProblem, assertSafeRegex, regexMatchAll } from './safeRegex';
import { ValidationError } from './errors';

describe('safeRegex validation', () => {
  it('accepts ordinary patterns', () => {
    for (const p of ['timeout', 'error.*db', '^GET /orders/\\d+ 5\\d\\d$', '(error|warn)', 'a{2,4}b', '[a-z]+\\s\\d+']) {
      expect(regexProblem(p), p).toBeNull();
    }
  });

  it('rejects empty, over-long and invalid patterns with clear messages', () => {
    expect(regexProblem('')).toMatch(/empty/i);
    expect(regexProblem('a'.repeat(201))).toMatch(/too long/i);
    expect(regexProblem('a'.repeat(50), 40)).toMatch(/max 40/);
    expect(regexProblem('(unclosed')).toMatch(/Invalid regular expression/);
    expect(regexProblem('[z-a]')).toMatch(/Invalid regular expression/);
  });

  it('rejects back-references', () => {
    expect(regexProblem('(a)\\1')).toMatch(/Back-references/);
  });

  it('rejects known ReDoS shapes (nested / alternated repetition)', () => {
    for (const p of ['(a+)+$', '(a*)*b', '(a|aa)+$', '(x+x+)+y', '((a+)b)*', '(.*a){10,}', '(a|a?)*c']) {
      expect(regexProblem(p), p).toMatch(/catastrophic/i);
    }
  });

  it('assertSafeRegex throws a 400 ValidationError', () => {
    try {
      assertSafeRegex('(a+)+$');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).statusCode).toBe(400);
    }
  });
});

describe('safeRegex execution budget', () => {
  it('matches case-insensitively and returns one flag per message', () => {
    expect(regexMatchAll('db.*timeout', ['DB pool TIMEOUT', 'all good'])).toEqual([true, false]);
  });

  it('time-boxes a catastrophic pattern that bypasses static validation', () => {
    // Calling the matcher directly (skipping validation) proves the vm timeout is the second line of defence.
    const evil = 'a'.repeat(40) + '!';
    const started = Date.now();
    expect(() => regexMatchAll('(a+)+$', [evil], 100)).toThrow(/longer than 100 ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
