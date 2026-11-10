// Shared, dependency-free helpers for the Node load runner and the tests (DPI 2 item 13).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(LOAD_DIR, file), 'utf8'));
}

// ---------------------------------------------------------------- stats
/** Nearest-rank percentile over an unsorted array (sorted copy is cached by the caller via summarize). */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Summarise one bucket { latencies: number[], errors, requests, bytes }. */
export function summarize(b, elapsedSec) {
  const sorted = [...b.latencies].sort((x, y) => x - y);
  const n = b.requests;
  return {
    requests: n,
    reqPerSec: elapsedSec > 0 ? +(n / elapsedSec).toFixed(2) : 0,
    errors: b.errors,
    errorRate: n ? +(b.errors / n).toFixed(5) : 0,
    p50: Math.round(percentile(sorted, 50)),
    p90: Math.round(percentile(sorted, 90)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    max: Math.round(sorted.length ? sorted[sorted.length - 1] : 0),
    avg: sorted.length ? Math.round(sorted.reduce((a, c) => a + c, 0) / sorted.length) : 0,
    bytes: b.bytes,
  };
}

export const emptyBucket = () => ({ latencies: [], errors: 0, requests: 0, bytes: 0 });

// ---------------------------------------------------------------- thresholds
/**
 * Evaluate draft thresholds against a run summary.
 * summary = { groups: { name: {p95,p99,errorRate,requests,...} }, overall: {...} }
 * Latency limits are multiplied by `scale`; error-rate limits are not. Groups with no requests are skipped.
 * Returns { ok, results: [{ metric, limit, actual, ok, skipped? }] }.
 */
export function evaluateThresholds(summary, thresholds, scale = 1) {
  const results = [];
  const check = (metric, actual, limit) => results.push({ metric, limit, actual, ok: actual <= limit });
  for (const [group, t] of Object.entries(thresholds.groups ?? {})) {
    const s = summary.groups?.[group];
    if (!s || s.requests === 0) {
      results.push({ metric: `${group}.p95`, limit: t.p95 * scale, actual: null, ok: true, skipped: true });
      continue;
    }
    for (const key of ['p50', 'p90', 'p95', 'p99']) {
      if (t[key] !== undefined) check(`${group}.${key}`, s[key], t[key] * scale);
    }
  }
  const o = thresholds.overall ?? {};
  if (summary.overall && summary.overall.requests > 0) {
    if (o.errorRate !== undefined) check('overall.errorRate', summary.overall.errorRate, o.errorRate);
    for (const key of ['p50', 'p90', 'p95', 'p99']) {
      if (o[key] !== undefined) check(`overall.${key}`, summary.overall[key], o[key] * scale);
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

// ---------------------------------------------------------------- scenario definitions
const ROUTE_PREFIXES = ['/api/auth/', '/api/dashboard/', '/api/health/', '/api/preferences', '/api/alerts', '/api/logs', '/api/chat', '/api/audit'];

/** Structural validation; returns a list of problems (empty = valid). */
export function validateDefinition(def, thresholds) {
  const problems = [];
  const groups = new Set(Object.keys(thresholds?.groups ?? {}));
  const names = new Set();
  if (!def.scenarios || !Object.keys(def.scenarios).length) problems.push('no scenarios');
  for (const [sid, sc] of Object.entries(def.scenarios ?? {})) {
    if (!Array.isArray(sc.think) || sc.think.length !== 2 || sc.think[0] > sc.think[1]) problems.push(`${sid}: think must be [min,max]`);
    if (!sc.requests?.length) problems.push(`${sid}: no requests`);
    for (const r of sc.requests ?? []) {
      if (!r.name || names.has(r.name)) problems.push(`${sid}: duplicate or missing request name ${r.name}`);
      names.add(r.name);
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)) problems.push(`${r.name}: bad method`);
      if (!ROUTE_PREFIXES.some((p) => r.path.startsWith(p))) problems.push(`${r.name}: unknown route ${r.path}`);
      if (!groups.has(r.group)) problems.push(`${r.name}: group ${r.group} has no threshold`);
      if (!Array.isArray(r.expect) || !r.expect.length) problems.push(`${r.name}: expect[] required`);
    }
  }
  for (const [pid, p] of Object.entries(def.profiles ?? {})) {
    const total = Object.values(p.weights ?? {}).reduce((a, c) => a + c, 0);
    if (total !== 100) problems.push(`profile ${pid}: weights sum to ${total}, expected 100`);
    for (const sid of Object.keys(p.weights ?? {})) if (!def.scenarios[sid]) problems.push(`profile ${pid}: unknown scenario ${sid}`);
  }
  return problems;
}

// ---------------------------------------------------------------- templating
/** Deterministic-capable template resolver: {{key}} from ctx, {{pick:a|b|c}} via rng(). */
export function resolveTemplate(value, ctx, rng = Math.random) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/g, (_m, key) => {
      if (key.startsWith('pick:')) {
        const options = key.slice(5).split('|');
        return options[Math.floor(rng() * options.length)];
      }
      return ctx[key] ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, ctx, rng));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplate(v, ctx, rng)]));
  return value;
}

/** Response check: status in expect[], optional dotted JSON paths exist, optional header substring. */
export function jsonHasPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

export function parseDuration(s) {
  if (typeof s === 'number') return s * 1000;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'];
  return Math.round(Number(m[1]) * mult);
}

export function pickScenario(weights, rng = Math.random) {
  const entries = Object.entries(weights);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let roll = rng() * total;
  for (const [id, w] of entries) {
    roll -= w;
    if (roll < 0) return id;
  }
  return entries[entries.length - 1][0];
}
