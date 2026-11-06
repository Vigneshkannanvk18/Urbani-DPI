import vm from 'node:vm';
import { ValidationError } from './errors';

/**
 * Bounded user-regex support for log search (DPI 2 item 4).
 *
 * User supplied regular expressions are never evaluated with unbounded cost:
 *  1. Static validation: max length, must compile, no back-references, and no
 *     "ambiguous repetition" (a quantified group that itself contains a quantifier
 *     or an alternation, e.g. `(a+)+`, `(a|aa)*`, `(.*)*`). These are the shapes
 *     that cause catastrophic backtracking.
 *  2. Bounded input: each message is truncated to MAX_MATCH_CHARS before matching.
 *  3. Hard time budget: matching runs inside a `node:vm` script with a `timeout`,
 *     so V8 terminates a runaway match instead of blocking the event loop. A timeout
 *     is reported to the caller as a 400, never as a silent partial result.
 */

export const DEFAULT_REGEX_MAX_LENGTH = 200;
export const MAX_MATCH_CHARS = 1000;
export const DEFAULT_REGEX_BUDGET_MS = 250;

/** Returns the reason a pattern is unsafe/invalid, or null when it is acceptable. */
export function regexProblem(pattern: string, maxLength = DEFAULT_REGEX_MAX_LENGTH): string | null {
  if (pattern.length === 0) return 'Regex must not be empty.';
  if (pattern.length > maxLength) return `Regex is too long (max ${maxLength} characters).`;
  try {
    new RegExp(pattern, 'i');
  } catch (err) {
    return `Invalid regular expression: ${err instanceof Error ? err.message : 'syntax error'}.`;
  }
  if (/\\[1-9]|\\k</.test(pattern.replace(/\\\\/g, ''))) return 'Back-references are not allowed in log regex.';
  return ambiguousRepetition(pattern)
    ? 'Regex rejected: nested or alternated repetition such as (a+)+ can cause catastrophic backtracking. Simplify the pattern.'
    : null;
}

/** True when a quantified group contains an inner quantifier or an alternation. */
function ambiguousRepetition(p: string): boolean {
  interface Frame { quant: boolean; alt: boolean }
  const stack: Frame[] = [];
  let inClass = false;
  const isQuantAt = (i: number): boolean => {
    const c = p[i];
    if (c === '*' || c === '+') return true;
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
      if (!m) return false;
      // {n} and {n,m} with m <= 1 are not repetition; {n,} and {n,m>1} are.
      if (!m[2]) return Number(m[1]) > 1;
      return m[3] === '' || Number(m[3]) > 1;
    }
    return false; // '?' alone is bounded
  };
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { stack.push({ quant: false, alt: false }); continue; }
    if (c === '|' && stack.length) { stack[stack.length - 1].alt = true; continue; }
    if (c === ')') {
      const f = stack.pop();
      if (!f) continue;
      const next = i + 1;
      const groupQuantified = next < p.length && isQuantAt(next);
      if (groupQuantified && (f.quant || f.alt)) return true;
      // The group (with whatever it contains) counts as a quantifier for its parent when repeated.
      if (stack.length && (f.quant || groupQuantified)) stack[stack.length - 1].quant = true;
      continue;
    }
    if (stack.length && isQuantAt(i)) stack[stack.length - 1].quant = true;
  }
  return false;
}

/** Validate a user pattern; throws a 400 ValidationError with a clear message. */
export function assertSafeRegex(pattern: string, maxLength = DEFAULT_REGEX_MAX_LENGTH): void {
  const problem = regexProblem(pattern, maxLength);
  if (problem) throw new ValidationError(problem, { field: 'search', regex: true });
}

/**
 * Case-insensitive regex test of every message under a hard time budget.
 * Returns one boolean per message. Throws ValidationError(400) when the budget is exceeded.
 */
export function regexMatchAll(pattern: string, messages: string[], budgetMs = DEFAULT_REGEX_BUDGET_MS): boolean[] {
  const bounded = messages.map((m) => (m.length > MAX_MATCH_CHARS ? m.slice(0, MAX_MATCH_CHARS) : m));
  const context = vm.createContext({ pattern, bounded });
  try {
    const out = new vm.Script('(() => { const re = new RegExp(pattern, "i"); return bounded.map((m) => re.test(m)); })()').runInContext(
      context,
      { timeout: budgetMs },
    ) as unknown as boolean[];
    return Array.from(out, Boolean);
  } catch (err) {
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timed out/i.test(String(e?.message ?? ''))) {
      throw new ValidationError(
        `Regex took longer than ${budgetMs} ms to evaluate and was stopped. Use a simpler pattern.`,
        { field: 'search', regex: true },
      );
    }
    throw new ValidationError(`Invalid regular expression: ${String(e?.message ?? 'error')}.`, {
      field: 'search',
      regex: true,
    });
  }
}
