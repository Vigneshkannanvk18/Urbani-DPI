import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain ESM helpers shared with the load runner (no types)
import { evaluateThresholds, validateDefinition, summarize, percentile, resolveTemplate, parseDuration, pickScenario, loadJson } from '../../../../load/lib/shared.mjs';
// @ts-expect-error plain ESM
import { buildStandalone } from '../../../../load/k6/bundle.mjs';
import { apiRoutes } from '../routes/apiRoutes';

/** Load-test assets (DPI 2 item 13): thresholds evaluator, scenario schema, k6 bundle sync. No network. */
const thresholds = loadJson('thresholds.json');
const def = loadJson('scenarios.json');

const summaryWith = (over: Record<string, unknown>) => ({
  groups: { read: { requests: 100, p50: 10, p90: 50, p95: 100, p99: 200, errorRate: 0 }, search: { requests: 10, p95: 900, p99: 1000, errorRate: 0 }, ...over },
  overall: { requests: 110, p95: 100, p99: 1000, errorRate: 0.001 },
});

describe('evaluateThresholds', () => {
  it('passes within limits and skips groups with no traffic', () => {
    const r = evaluateThresholds(summaryWith({}), thresholds);
    expect(r.ok).toBe(true);
    expect(r.results.find((x: { metric: string }) => x.metric === 'export.p95').skipped).toBe(true);
  });
  it('flags a latency breach and an error-rate breach', () => {
    const slow = evaluateThresholds(summaryWith({ read: { requests: 5, p95: 801, p99: 900, errorRate: 0 } }), thresholds);
    expect(slow.ok).toBe(false);
    expect(slow.results.find((x: { ok: boolean }) => !x.ok).metric).toBe('read.p95');
    const errs = summaryWith({});
    errs.overall.errorRate = 0.02;
    expect(evaluateThresholds(errs, thresholds).ok).toBe(false);
  });
  it('scales latency limits but never the error budget', () => {
    const slow = summaryWith({ read: { requests: 5, p95: 1500, p99: 1600, errorRate: 0 } });
    expect(evaluateThresholds(slow, thresholds, 1).ok).toBe(false);
    expect(evaluateThresholds(slow, thresholds, 2).ok).toBe(true);
    const errs = summaryWith({});
    errs.overall.errorRate = 0.02;
    expect(evaluateThresholds(errs, thresholds, 100).ok).toBe(false);
  });
  it('is explicitly labelled as a draft pending client input', () => {
    expect(thresholds.status).toMatch(/placeholder|DRAFT/i);
    expect(thresholds.status).toMatch(/#14/);
  });
});

describe('stats helpers', () => {
  it('computes nearest-rank percentiles and summaries', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile([], 95)).toBe(0);
    const s = summarize({ latencies: sorted, errors: 5, requests: 100, bytes: 10 }, 10);
    expect(s).toMatchObject({ p99: 99, max: 100, errorRate: 0.05, reqPerSec: 10 });
  });
  it('resolves templates, durations and weighted picks', () => {
    expect(resolveTemplate({ a: '{{x}}-{{pick:q|q}}' }, { x: '1' })).toEqual({ a: '1-q' });
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(pickScenario({ a: 1, b: 0 }, () => 0.5)).toBe('a');
  });
});

describe('scenario definition', () => {
  it('is structurally valid (every request has a threshold group, weights sum to 100)', () => {
    expect(validateDefinition(def, thresholds)).toEqual([]);
  });
  it('rejects a broken definition', () => {
    const bad = JSON.parse(JSON.stringify(def));
    bad.scenarios.dashboard.requests[0].path = '/api/nope';
    bad.profiles.smoke.weights.dashboard = 1;
    const problems = validateDefinition(bad, thresholds) as string[];
    expect(problems.some((p) => /unknown route/.test(p))).toBe(true);
    expect(problems.some((p) => /weights sum/.test(p))).toBe(true);
  });
  it('references only routes that exist in the API (static routes and param routes)', () => {
    const routes: string[] = [];
    const walk = (stack: any[], prefix: string) => {
      for (const l of stack) {
        if (l.route) routes.push(prefix + l.route.path);
        else if (l.name === 'router' && l.handle?.stack) {
          const src: string = l.regexp?.source ?? '';
          const m = /^\^\\\/([^\\?(]+)/.exec(src);
          walk(l.handle.stack, m ? `${prefix}/${m[1]}` : prefix);
        }
      }
    };
    walk((apiRoutes as any).stack, '/api');
    routes.push('/api/auth/login');
    const norm = (p: string) => p.replace(/\{\{[^}]+\}\}/g, ':p').replace(/:[A-Za-z]+/g, ':p').replace(/\/$/, '');
    const known = new Set(routes.map(norm));
    for (const sc of Object.values<any>(def.scenarios)) {
      for (const r of sc.requests) {
        expect(known.has(norm(r.path)), `${r.method} ${r.path} is not an API route`).toBe(true);
      }
    }
  });
});

describe('k6 assets', () => {
  it('standalone bundle for AWS Distributed Load Testing is in sync with scenarios.json / thresholds.json', () => {
    const file = path.resolve(__dirname, '../../../../load/k6/dpi-load.standalone.js');
    expect(fs.readFileSync(file, 'utf8')).toBe(buildStandalone());
  });
});
