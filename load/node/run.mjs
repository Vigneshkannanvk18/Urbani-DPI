#!/usr/bin/env node
/**
 * Dependency-free load runner (DPI 2 item 13). Runs the SAME scenarios as the k6 scripts (load/scenarios.json)
 * against a locally started backend and evaluates the DRAFT thresholds (load/thresholds.json).
 *
 *   node load/node/serve.mjs --volume 50000 --port 4100        # terminal 1 (mock integrations only)
 *   node load/node/run.mjs --base http://127.0.0.1:4100 --profile realistic --vus 50 --duration 150s --rampUp 30s
 *
 * Options
 *   --base <url>            target (default http://127.0.0.1:4100). NEVER point this at production, the Urbani QA API
 *                           Gateway or any AWS endpoint without written approval (see docs/LOAD_TESTING.md).
 *   --profile <name>        smoke | realistic | search-heavy | spike | soak (default realistic)
 *   --scenarios a,b         run only these scenarios (weights renormalised)
 *   --vus N  --duration 90s  --rampUp 20s        override the profile defaults
 *   --thinkScale 0.5        multiply every think time (0 = no think time: pure capacity test)
 *   --users N               create N extra users (READER_AUDITOR / INFRA_ADMIN) through the user API and spread the VUs over them
 *   --loginSamples N        sequential bcrypt logins measured on their own before the run (default 20)
 *   --thresholds <file>     default load/thresholds.json      --thresholdScale 3   stretch latency limits (laptop vs Fargate)
 *   --out <dir>             default load/results/<timestamp>   --noFail  exit 0 even on a breach
 *   --serverPid <pid>       sample that process' CPU / memory every 5 s (Windows PowerShell or ps)
 *   --email / --password    default admin@urbani.local / LoadTest-Passw0rd! (env LOAD_ADMIN_EMAIL / LOAD_ADMIN_PASSWORD)
 *
 * Exit code: 0 ok, 1 threshold breach, 2 setup problem.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  LOAD_DIR, loadJson, summarize, emptyBucket, evaluateThresholds, validateDefinition, resolveTemplate,
  jsonHasPath, parseDuration, pickScenario,
} from '../lib/shared.mjs';

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[k] = true;
  else { opt[k] = next; i++; }
}
const def = loadJson('scenarios.json');
const profileName = opt.profile ?? 'realistic';
const profile = def.profiles[profileName];
if (!profile) { console.error(`unknown profile ${profileName}; have ${Object.keys(def.profiles).join(', ')}`); process.exit(2); }
const thresholdsFile = opt.thresholds ? path.resolve(String(opt.thresholds)) : path.join(LOAD_DIR, 'thresholds.json');
const thresholds = JSON.parse(fs.readFileSync(thresholdsFile, 'utf8'));
const problems = validateDefinition(def, thresholds);
if (problems.length) { console.error(`invalid scenario definition:\n  ${problems.join('\n  ')}`); process.exit(2); }

const base = new URL(String(opt.base ?? 'http://127.0.0.1:4100'));
const vus = Number(opt.vus ?? profile.defaults.vus);
const durationMs = parseDuration(opt.duration ?? profile.defaults.duration);
const rampMs = parseDuration(opt.rampUp ?? profile.defaults.rampUp);
const thinkScale = Number(opt.thinkScale ?? 1);
const thresholdScale = Number(opt.thresholdScale ?? 1);
const email = String(opt.email ?? process.env.LOAD_ADMIN_EMAIL ?? 'admin@urbani.local');
const password = String(opt.password ?? process.env.LOAD_ADMIN_PASSWORD ?? 'LoadTest-Passw0rd!');
const extraUsers = Number(opt.users ?? 0);
const loginSamples = Number(opt.loginSamples ?? 20);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(String(opt.out ?? path.join(LOAD_DIR, 'results', stamp)));
const shape = profile.defaults.shape ?? 'ramp';

let weights = { ...profile.weights };
if (opt.scenarios) {
  const only = String(opt.scenarios).split(',');
  for (const s of only) if (!def.scenarios[s]) { console.error(`unknown scenario ${s}`); process.exit(2); }
  weights = Object.fromEntries(only.map((s) => [s, profile.weights[s] ?? 1]));
}

// ---------------------------------------------------------------- http (node:http keep-alive agent, no deps)
const isHttps = base.protocol === 'https:';
const agent = new (isHttps ? https : http).Agent({ keepAlive: true, maxSockets: Math.max(64, vus * 2), keepAliveMsecs: 30_000 });
const REQUEST_TIMEOUT_MS = 60_000;

function request(method, pathAndQuery, { token, body } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: '*/*', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const req = (isHttps ? https : http).request(
      { agent, method, hostname: base.hostname, port: base.port || (isHttps ? 443 : 80), path: pathAndQuery, headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => { bytes += c.length; if (chunks.length < 64 && bytes < 1_000_000) chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, text: Buffer.concat(chunks).toString('utf8'), ms: performance.now() - started }));
        res.on('error', () => resolve({ status: 0, headers: {}, bytes, text: '', ms: performance.now() - started, error: 'response error' }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, headers: {}, bytes: 0, text: '', ms: performance.now() - started, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const buildPath = (r, ctx) => {
  const p = resolveTemplate(r.path, ctx);
  if (!r.query) return p;
  const qs = new URLSearchParams(resolveTemplate(r.query, ctx)).toString();
  return `${p}?${qs}`;
};

// ---------------------------------------------------------------- metrics
let startedAt = Date.now(); // reset right before the virtual users start (setup is not part of the run)
const byRequest = new Map();
const byScenario = new Map();
const byGroup = new Map();
const overall = emptyBucket();
const failures = new Map(); // "name status" -> count
const timeline = new Map(); // second bucket -> { n, errors, sumMs, maxMs }
let checksPassed = 0;
let checksFailed = 0;
const bucket = (m, k) => { if (!m.has(k)) m.set(k, emptyBucket()); return m.get(k); };

function record(scenarioId, r, res, ok, reason) {
  for (const b of [bucket(byRequest, r.name), bucket(byScenario, scenarioId), bucket(byGroup, r.group), overall]) {
    b.requests++;
    b.latencies.push(res.ms);
    b.bytes += res.bytes;
    if (!ok) b.errors++;
  }
  if (!ok) {
    const key = `${r.name} -> ${res.status}${res.error ? ` ${res.error}` : ''}${reason ? ` (${reason})` : ''}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
  }
  const sec = Math.floor((Date.now() - startedAt) / 5000) * 5;
  const t = timeline.get(sec) ?? { n: 0, errors: 0, sumMs: 0, maxMs: 0 };
  t.n++; t.sumMs += res.ms; t.maxMs = Math.max(t.maxMs, res.ms); if (!ok) t.errors++;
  timeline.set(sec, t);
}

/** Runs one request with its checks; returns the parsed JSON (or null). */
async function exec(scenarioId, r, ctx, token) {
  const res = await request(r.method, buildPath(r, ctx), { token, body: r.body ? resolveTemplate(r.body, ctx) : undefined });
  let ok = r.expect.includes(res.status);
  let reason = '';
  let json = null;
  if (ok && r.jsonHas) {
    try {
      json = JSON.parse(res.text);
      const missing = r.jsonHas.filter((p) => !jsonHasPath(json, p));
      if (missing.length) { ok = false; reason = `missing ${missing.join(',')}`; }
    } catch { ok = false; reason = 'body is not JSON'; }
  }
  if (ok && r.header) {
    for (const [h, v] of Object.entries(r.header)) if (!String(res.headers[h] ?? '').includes(v)) { ok = false; reason = `header ${h}`; }
  }
  ok ? checksPassed++ : checksFailed++;
  record(scenarioId, r, res, ok, reason);
  return json;
}

// ---------------------------------------------------------------- setup (not counted in the run metrics)
async function login(e, p) {
  const t0 = performance.now();
  const res = await request('POST', '/api/auth/login', { body: { email: e, password: p } });
  if (res.status !== 200) return { ms: performance.now() - t0, status: res.status, token: null, user: null };
  const j = JSON.parse(res.text);
  return { ms: performance.now() - t0, status: 200, token: j.token, user: j.user };
}

async function setup() {
  const health = await request('GET', '/api/health');
  if (health.status !== 200) throw new Error(`target ${base.origin} is not healthy (status ${health.status}${health.error ? ` ${health.error}` : ''})`);
  const adminLogin = await login(email, password);
  if (!adminLogin.token) throw new Error(`login as ${email} failed (HTTP ${adminLogin.status}); set --email/--password or LOAD_ADMIN_*`);
  const admin = adminLogin.token;
  const users = [{ label: 'SUPER_ADMIN', token: admin }];
  if (extraUsers > 0) {
    const roles = ['READER_AUDITOR', 'INFRA_ADMIN'];
    for (let i = 0; i < extraUsers; i++) {
      const u = { email: `load-${stamp.slice(0, 19).toLowerCase()}-${i}@urbani.local`, displayName: `Load user ${i}`, role: roles[i % roles.length], password: 'LoadTest-User-Passw0rd!' };
      const created = await request('POST', '/api/users', { token: admin, body: u });
      if (created.status !== 201) throw new Error(`creating user ${u.email} failed: HTTP ${created.status} ${created.text.slice(0, 120)}`);
      const l = await login(u.email, u.password);
      if (!l.token) throw new Error(`login as created user failed (HTTP ${l.status})`);
      users.push({ label: u.role, token: l.token });
    }
  }
  // Login cost, measured on its own (bcrypt is real CPU): sequential.
  const loginMs = [];
  for (let i = 0; i < loginSamples; i++) {
    const l = await login(email, password);
    if (l.status === 200) loginMs.push(l.ms);
  }
  const alerts = JSON.parse((await request('GET', '/api/alerts?pageSize=1', { token: admin })).text || '{}');
  const alertId = alerts?.data?.items?.[0]?.alertId ?? '';
  const probe = await request('GET', '/api/logs?pageSize=1', { token: admin });
  const meta = (() => { try { const j = JSON.parse(probe.text); return { source: j.source, scope: j.meta?.scope, total: j.meta?.total, windowCap: j.meta?.windowCap }; } catch { return {}; } })();
  return { users, loginMs, ctx: { email, password, alertId, from: def.data.from, to: def.data.to }, logsProbe: meta };
}

// ---------------------------------------------------------------- virtual users
const rngSeedless = Math.random;
async function virtualUser(idx, user, ctx, win) {
  const { activeFrom, activeTo } = win;
  await sleep(Math.max(0, activeFrom - (Date.now() - startedAt)));
  const rate = (id) => thinkScale * (def.scenarios[id].think[0] + rngSeedless() * (def.scenarios[id].think[1] - def.scenarios[id].think[0]));
  while (Date.now() - startedAt < activeTo) {
    const sid = pickScenario(weights);
    const sc = def.scenarios[sid];
    const token = sid === 'auth' ? undefined : user.token;
    for (const r of sc.requests) {
      if (Date.now() - startedAt >= activeTo) break;
      if (sid === 'auth' && r.name === 'auth.login') await exec(sid, r, ctx, undefined);
      else await exec(sid, r, ctx, token);
      await sleep(rate(sid));
    }
  }
}

function vuWindow(i) {
  if (shape === 'spike') {
    const base = Math.max(1, Math.floor(vus / 4));
    if (i < base) return { activeFrom: (rampMs * i) / base, activeTo: durationMs };
    const third = durationMs / 3;
    return { activeFrom: third + (rampMs * (i - base)) / (vus - base || 1), activeTo: 2 * third };
  }
  return { activeFrom: (rampMs * i) / vus, activeTo: durationMs };
}

// ---------------------------------------------------------------- server sampling (optional)
const samples = [];
async function sampleServer(pid, stopSignal) {
  const cores = os.cpus().length;
  let prev = null;
  while (!stopSignal.done) {
    const s = await new Promise((resolve) => {
      const cmd = process.platform === 'win32'
        ? ['powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if($p){"$($p.CPU) $($p.WorkingSet64)"}`]]
        : ['ps', ['-o', 'cputime=,rss=', '-p', String(Number(pid))]];
      const ch = spawn(cmd[0], cmd[1], { windowsHide: true });
      let out = '';
      ch.stdout.on('data', (d) => { out += d; });
      ch.on('close', () => resolve(out.trim()));
      ch.on('error', () => resolve(''));
    });
    const [cpuRaw, memRaw] = s.split(/\s+/);
    const cpu = Number(cpuRaw);
    const now = Date.now();
    if (Number.isFinite(cpu) && prev) {
      samples.push({ t: Math.round((now - startedAt) / 1000), cpuPct: +(((cpu - prev.cpu) / ((now - prev.t) / 1000)) * 100 / cores).toFixed(1), cpuOneCorePct: +(((cpu - prev.cpu) / ((now - prev.t) / 1000)) * 100).toFixed(1), rssMb: Math.round(Number(memRaw) / (process.platform === 'win32' ? 1048576 : 1024)) });
    }
    if (Number.isFinite(cpu)) prev = { cpu, t: now };
    await sleep(4000);
  }
}

// ---------------------------------------------------------------- report
function pad(s, n, right = false) { s = String(s); return right ? s.padStart(n) : s.padEnd(n); }
function table(rows, title) {
  const head = ['name', 'reqs', 'req/s', 'p50', 'p90', 'p95', 'p99', 'max', 'err%', 'KB/s'];
  const lines = [title, head.map((h, i) => pad(h, i === 0 ? 28 : 7, i > 0)).join(' ')];
  for (const [name, s] of rows) {
    lines.push([pad(name, 28), pad(s.requests, 7, true), pad(s.reqPerSec, 7, true), pad(s.p50, 7, true), pad(s.p90, 7, true), pad(s.p95, 7, true), pad(s.p99, 7, true), pad(s.max, 7, true), pad((s.errorRate * 100).toFixed(2), 7, true), pad(Math.round(s.bytes / 1024 / elapsedSec), 7, true)].join(' '));
  }
  return lines.join('\n');
}
let elapsedSec = 0;

function markdown(result) {
  const row = (n, s) => `| ${n} | ${s.requests} | ${s.reqPerSec} | ${s.p50} | ${s.p90} | ${s.p95} | ${s.p99} | ${s.max} | ${(s.errorRate * 100).toFixed(2)}% |`;
  const head = '| name | requests | req/s | p50 ms | p90 ms | p95 ms | p99 ms | max ms | errors |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const md = [];
  md.push(`# Load run ${result.meta.startedAt}`, '');
  md.push(`DRAFT thresholds (placeholder pending Urbani client input #14), latency scale x${result.meta.thresholdScale}. Verdict: **${result.thresholds.ok ? 'PASS' : 'BREACH'}**.`, '');
  md.push('## Run', '', '```json', JSON.stringify(result.meta, null, 2), '```', '');
  md.push('## Overall', '', head, row('overall', result.overall), '');
  md.push('## Per scenario', '', head, ...Object.entries(result.scenarios).map(([n, s]) => row(n, s)), '');
  md.push('## Per request group', '', head, ...Object.entries(result.groups).map(([n, s]) => row(n, s)), '');
  md.push('## Per endpoint', '', head, ...Object.entries(result.requests).map(([n, s]) => row(n, s)), '');
  md.push('## Login (bcrypt) measured on its own', '', '```json', JSON.stringify(result.login, null, 2), '```', '');
  md.push('## Threshold verdicts', '', '| metric | limit | actual | result |', '|---|---:|---:|---|', ...result.thresholds.results.map((r) => `| ${r.metric} | ${r.limit} | ${r.actual ?? '-'} | ${r.skipped ? 'skipped (no traffic)' : r.ok ? 'ok' : 'BREACH'} |`), '');
  if (result.failures.length) md.push('## Failures', '', ...result.failures.map((f) => `- ${f.count} x ${f.what}`), '');
  if (result.server.length) md.push('## Server samples (every ~4 s)', '', '```json', JSON.stringify(result.server), '```', '');
  return md.join('\n');
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`[load] target ${base.origin}  profile=${profileName}  vus=${vus}  duration=${durationMs / 1000}s  rampUp=${rampMs / 1000}s  thinkScale=${thinkScale}`);
  const eld = monitorEventLoopDelay({ resolution: 10 });
  const setupState = await setup().catch((e) => { console.error(`[load] setup failed: ${e.message}`); process.exit(2); });
  const { users, loginMs, ctx, logsProbe } = setupState;
  console.log(`[load] setup ok: ${users.length} user token(s), alertId=${ctx.alertId || '(none)'}, logs source=${logsProbe.source} window=${logsProbe.windowCap} scope="${logsProbe.scope}"`);
  const stop = { done: false };
  startedAt = Date.now();
  const sampler = opt.serverPid ? sampleServer(opt.serverPid, stop) : Promise.resolve();
  eld.enable();
  await Promise.all(Array.from({ length: vus }, (_, i) => virtualUser(i, users[i % users.length], ctx, vuWindow(i))));
  eld.disable();
  stop.done = true;
  elapsedSec = (Date.now() - startedAt) / 1000;
  await sampler.catch(() => {});

  const mapSummary = (m) => Object.fromEntries([...m.entries()].map(([k, b]) => [k, summarize(b, elapsedSec)]));
  const summary = { overall: summarize(overall, elapsedSec), scenarios: mapSummary(byScenario), groups: mapSummary(byGroup), requests: mapSummary(byRequest) };
  const verdict = evaluateThresholds(summary, thresholds, thresholdScale);
  const loginSorted = [...loginMs].sort((a, b) => a - b);
  const pct = (p) => (loginSorted.length ? Math.round(loginSorted[Math.min(loginSorted.length - 1, Math.ceil((p / 100) * loginSorted.length) - 1)]) : null);
  const result = {
    meta: {
      startedAt: new Date(startedAt).toISOString(), base: base.origin, profile: profileName, weights, vus, durationSec: durationMs / 1000, rampUpSec: rampMs / 1000,
      shape, thinkScale, thresholdScale, thresholdsStatus: thresholds.status, extraUsers, userRoles: users.map((u) => u.label), elapsedSec: +elapsedSec.toFixed(1),
      logsProbe, checks: { passed: checksPassed, failed: checksFailed },
      runnerEventLoopDelayMs: { p50: +(eld.percentile(50) / 1e6).toFixed(1), p99: +(eld.percentile(99) / 1e6).toFixed(1), max: +(eld.max / 1e6).toFixed(1) },
      machine: { cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, ramGb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, platform: `${os.platform()} ${os.release()}` },
    },
    ...summary,
    login: { samples: loginMs.length, p50: pct(50), p95: pct(95), max: loginSorted.length ? Math.round(loginSorted[loginSorted.length - 1]) : null, note: 'sequential logins before the load started' },
    thresholds: verdict,
    failures: [...failures.entries()].map(([what, count]) => ({ what, count })).sort((a, b) => b.count - a.count),
    timeline: [...timeline.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, n: v.n, errors: v.errors, avgMs: Math.round(v.sumMs / v.n), maxMs: Math.round(v.maxMs) })),
    server: samples,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown(result));

  console.log('');
  console.log(table([['OVERALL', summary.overall]], `== overall (${elapsedSec.toFixed(0)} s, ${checksPassed} checks ok / ${checksFailed} failed) ==`));
  console.log(table(Object.entries(summary.scenarios), '\n== per scenario =='));
  console.log(table(Object.entries(summary.groups), '\n== per group =='));
  console.log(table(Object.entries(summary.requests), '\n== per endpoint =='));
  console.log(`\nlogin (bcrypt, sequential x${loginMs.length}): p50 ${result.login.p50} ms, p95 ${result.login.p95} ms, max ${result.login.max} ms`);
  console.log(`runner event-loop delay p99 ${result.meta.runnerEventLoopDelayMs.p99} ms (high values mean the runner, not the server, is the bottleneck)`);
  if (result.failures.length) console.log('\nfailures:\n' + result.failures.slice(0, 10).map((f) => `  ${f.count} x ${f.what}`).join('\n'));
  if (samples.length) {
    const cpu = samples.map((s) => s.cpuOneCorePct);
    console.log(`\nserver: CPU avg ${(cpu.reduce((a, c) => a + c, 0) / cpu.length).toFixed(0)}% of one core (max ${Math.max(...cpu)}%), RSS ${samples[0].rssMb} -> ${samples[samples.length - 1].rssMb} MB (max ${Math.max(...samples.map((s) => s.rssMb))})`);
  }
  console.log(`\nthresholds (${thresholds.status}) x${thresholdScale}:`);
  for (const r of verdict.results) console.log(`  ${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'} ${r.metric.padEnd(18)} actual ${String(r.actual ?? '-').padStart(6)}  limit ${r.limit}`);
  console.log(`\nresults written to ${outDir}`);
  agent.destroy();
  if (!verdict.ok && !opt.noFail) { console.log('RESULT: THRESHOLD BREACH'); process.exit(1); }
  console.log(`RESULT: ${verdict.ok ? 'PASS' : 'BREACH (ignored by --noFail)'}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
