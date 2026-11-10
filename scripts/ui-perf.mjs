#!/usr/bin/env node
/**
 * UI performance check under a large synthetic log volume (DPI 2 item 13, dev-only). NO dependencies: Node 24
 * built-ins + Microsoft Edge/Chrome over the Chrome DevTools Protocol, same approach as scripts/ui-smoke.mjs.
 *
 *   npm run build
 *   node scripts/ui-perf.mjs                       # backend with MOCK_LOG_VOLUME=50000
 *   UI_PERF_BG=1 node scripts/ui-perf.mjs          # + moderate background API load (load/node/run.mjs) while measuring
 *
 * Starts the compiled backend (port 4100, INTEGRATION_MODE=mock, MOCK_LOG_VOLUME, worktree-local SQLite under
 * .tmp/ui-perf) and the Vite dev server (5273), launches headless Edge with its own profile (debug port 9333), logs in
 * and measures, with a PerformanceObserver ('longtask') plus CDP Performance.getMetrics:
 *   - Logs page: time to first rendered rows, long tasks (> 50 ms) per phase, DOM nodes, JS heap, layout/style recalcs
 *     during initial load, paging, a filter change and typing in the search box (and the regex box).
 *   - Dashboard and Alerts pages once.
 * Writes .tmp/ui-perf/perf.json + screenshots and evaluates DRAFT thresholds (placeholders, see docs/LOAD_TESTING.md):
 * first rows < 2500 ms, no long task > 250 ms during interaction, heap < 250 MB, DOM nodes on Logs < 5000.
 * Everything it starts is killed in a finally block. Env: UI_PERF_VOLUME (50000), UI_PERF_BROWSER, UI_PERF_BG, UI_PERF_NOFAIL.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.tmp', 'ui-perf');
const BACKEND_PORT = 4100;
const FRONTEND_PORT = 5273;
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${FRONTEND_PORT}`;
const API = `http://127.0.0.1:${BACKEND_PORT}`;
const VOLUME = Number(process.env.UI_PERF_VOLUME ?? 50000);
const ADMIN = { email: 'admin@urbani.local', password: 'PerfTest-Passw0rd!' };
const LIMITS = { firstRowsMs: 2500, longTaskMs: 250, heapMb: 250, logsDomNodes: 5000 }; // DRAFT placeholders
const BROWSERS = [
  process.env.UI_PERF_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const log = (m) => console.log(`[ui-perf] ${m}`);

function start(name, cmd, args, opts = {}) {
  const out = fs.openSync(path.join(OUT, `${name}.log`), 'w');
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ['ignore', out, out], windowsHide: true });
  child.on('error', (e) => log(`${name} failed to start: ${e.message}`));
  children.push({ name, child });
  return child;
}
function killAll() {
  for (const { name, child } of children.splice(0)) {
    if (child.exitCode !== null || !child.pid) continue;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch { /* already gone */ }
    log(`stopped ${name}`);
  }
}
async function waitFor(url, label, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; last = `HTTP ${r.status}`; } catch (e) { last = e.cause?.code ?? e.message; }
    await sleep(400);
  }
  throw new Error(`${label} did not become ready (${last}) at ${url}`);
}

// ---------------------------------------------------------------- minimal CDP client (same as ui-smoke.mjs)
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result ?? {});
      } else if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {});
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 60_000).unref?.();
    });
  }
  on(method, handler) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(handler); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// In-page instrumentation, installed before any app script runs.
const INSTRUMENT = `(() => {
  if (window.__perf) return;
  const p = window.__perf = { longtasks: [], firstRows: null, rowsSeenAt: [] };
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) p.longtasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) }); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) { p.longtaskUnsupported = true; }
  const mo = new MutationObserver(() => {
    if (p.firstRows === null && document.querySelector('table.data tbody tr')) p.firstRows = Math.round(performance.now());
  });
  const arm = () => document.documentElement ? mo.observe(document.documentElement, { childList: true, subtree: true }) : setTimeout(arm, 0);
  arm();
})()`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const dist = path.join(ROOT, 'packages', 'backend', 'dist', 'server.js');
  if (!fs.existsSync(dist)) throw new Error('packages/backend/dist is missing: run `npm run build` first');
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) throw new Error('No Edge/Chrome found; set UI_PERF_BROWSER');
  for (const port of [BACKEND_PORT, FRONTEND_PORT, CDP_PORT]) {
    if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} is already in use; stop that process first`);
  }

  const env = {
    NODE_ENV: 'development', PORT: String(BACKEND_PORT), INTEGRATION_MODE: 'mock', DB_DRIVER: 'sqlite',
    DATABASE_URL: path.join(OUT, 'urbani-perf.sqlite'), JWT_SECRET: 'ui-perf-secret-not-for-production',
    SEED_ADMIN_EMAIL: ADMIN.email, SEED_ADMIN_PASSWORD: ADMIN.password, LOG_LEVEL: 'warn', RATE_LIMIT_DISABLED: '1',
    MOCK_LOG_VOLUME: String(VOLUME), HEALTH_PROBE_INTERVAL_SECONDS: '60', URBANI_API_BASE_URL: '', URBANI_API_KEY: '',
  };
  for (const script of ['migrate.js', 'seed.js']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'packages', 'backend', 'dist', 'db', script)], { cwd: path.join(ROOT, 'packages', 'backend'), env: { ...process.env, ...env }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  start('backend', process.execPath, [dist], { cwd: path.join(ROOT, 'packages', 'backend'), env });
  await waitFor(`${API}/api/health`, 'backend');
  start('vite', process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(FRONTEND_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(ROOT, 'packages', 'frontend'), env: { VITE_DEV_PORT: String(FRONTEND_PORT), VITE_DEV_API_PORT: String(BACKEND_PORT), FORCE_COLOR: '0' },
  });
  await waitFor(`${BASE}/`, 'vite dev server');
  start('browser', browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank',
  ]);
  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 'browser debugging endpoint');
  const target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  for (const d of ['Page', 'Runtime', 'Network', 'Performance', 'HeapProfiler']) await cdp.send(`${d}.enable`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const gc = () => cdp.send('HeapProfiler.collectGarbage');
  const shot = async (name) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
  };

  // Login through the API, then hand the token to the app like the login page does.
  const login = await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) })).json();
  const token = login.token;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('urbani.token',${JSON.stringify(token)});localStorage.setItem('urbani.theme','light')}catch(e){}` });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });

  // Optional moderate background load from the Node runner while the UI is measured.
  let bg = null;
  if (process.env.UI_PERF_BG === '1') {
    bg = start('background-load', process.execPath, [path.join(ROOT, 'load', 'node', 'run.mjs'), '--base', API, '--profile', 'realistic', '--vus', '15', '--duration', '150s', '--rampUp', '5s', '--thinkScale', '0.5', '--noFail', '--out', path.join(OUT, 'background-load')], {
      env: { LOAD_ADMIN_EMAIL: ADMIN.email, LOAD_ADMIN_PASSWORD: ADMIN.password },
    });
    log('background load started (15 VUs, thinkScale 0.5)');
    await sleep(8000);
  }

  const nav = async (pathname) => {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(150);
    await cdp.send('Page.navigate', { url: `${BASE}${pathname}` });
    await sleep(300);
  };
  const waitFor_ = async (fn, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evalJs('!!(' + fn + ')')) return true; await sleep(25); }
    return false;
  };
  const settle = async (ms = 700) => { await sleep(ms); };
  const domNodes = () => evalJs('document.getElementsByTagName("*").length');
  const sinceLong = (mark) => evalJs(`window.__perf.longtasks.filter((t) => t.start >= ${mark})`);
  const now = () => evalJs('Math.round(performance.now())');

  /** Run an interaction and describe what the main thread did during it. */
  const phase = async (name, action, { done } = {}) => {
    const m0 = await metrics();
    const t0 = await now();
    const wall0 = performance.now();
    await action();
    let tDone = null;
    if (done) { const ok = await waitFor_(done); tDone = ok ? Math.round(performance.now() - wall0) : null; }
    await settle();
    const m1 = await metrics();
    const lts = await sinceLong(t0);
    const res = {
      name, completeMs: tDone, longTasks: lts.length, longTaskMaxMs: lts.reduce((a, t) => Math.max(a, t.duration), 0), longTaskTotalMs: lts.reduce((a, t) => a + t.duration, 0),
      layouts: Math.round(m1.LayoutCount - m0.LayoutCount), styleRecalcs: Math.round(m1.RecalcStyleCount - m0.RecalcStyleCount),
      scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000),
      domNodes: await domNodes(), heapMb: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
    };
    log(`${name.padEnd(28)} done=${String(res.completeMs).padStart(5)}ms longtasks=${res.longTasks} (max ${res.longTaskMaxMs}ms) layouts=${res.layouts} recalcs=${res.styleRecalcs} dom=${res.domNodes} heap=${res.heapMb}MB`);
    return res;
  };
  const rowsFirstText = () => evalJs(`(document.querySelector('table.data tbody tr td:nth-child(4)') || {}).innerText || ''`);
  const typeText = async (text, delay = 70) => {
    for (const ch of text) { await cdp.send('Input.insertText', { text: ch }); await sleep(delay); }
  };
  const focus = (sel) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); return true; })()`);
  const click = (js) => evalJs(`(() => { const b = ${js}; if (!b || b.disabled) return false; b.click(); return true; })()`);

  const result = { startedAt: new Date().toISOString(), volume: VOLUME, backgroundLoad: process.env.UI_PERF_BG === '1', limits: LIMITS, machine: { cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, ramGb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, browser: (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).Browser }, pages: {}, interactions: [] };

  // ---- Logs page: first rows. A cold pass first (the Vite dev server transforms modules on demand), then the warm pass.
  await nav('/logs');
  await waitFor_('window.__perf && window.__perf.firstRows !== null');
  const coldFirstRows = await evalJs('window.__perf.firstRows');
  await settle(800);
  await nav('/logs');
  await waitFor_('window.__perf && window.__perf.firstRows !== null');
  await settle(1000);
  const first = await evalJs('window.__perf.firstRows');
  const lt0 = await evalJs('window.__perf.longtasks');
  const m = await metrics();
  const meta = await evalJs(`(() => { const t = document.querySelector('.text-secondary'); return t ? t.innerText.slice(0, 200) : ''; })()`);
  result.pages.logs = {
    coldFirstRowsMs: coldFirstRows, firstRowsMs: first, initialLongTasks: lt0.length, initialLongTaskMaxMs: lt0.reduce((a, t) => Math.max(a, t.duration), 0), domNodes: await domNodes(),
    heapMb: +(m.JSHeapUsedSize / 1048576).toFixed(1), layouts: Math.round(m.LayoutCount), styleRecalcs: Math.round(m.RecalcStyleCount), rowsRendered: await evalJs('document.querySelectorAll("table.data tbody tr").length'), scopeText: meta,
  };
  log(`logs first rows ${first} ms, initial long tasks ${lt0.length} (max ${result.pages.logs.initialLongTaskMaxMs} ms), dom ${result.pages.logs.domNodes}, rows ${result.pages.logs.rowsRendered}`);
  await shot('logs-initial');

  // ---- Interactions on /logs
  const ix = result.interactions;
  const before = await rowsFirstText();
  ix.push(await phase('paging: next page', () => click('document.querySelector(\'button[aria-label="Next page"]\')'), { done: `(document.querySelector('.page-info')||{}).innerText && /Page 2 of/.test(document.querySelector('.page-info').innerText) && document.querySelector('table.data tbody tr')` }));
  ix.push(await phase('paging: x5 quick next', async () => { for (let i = 0; i < 5; i++) { await click('document.querySelector(\'button[aria-label="Next page"]\')'); await sleep(120); } }, { done: `/Page 7 of/.test((document.querySelector('.page-info')||{}).innerText||'')` }));
  ix.push(await phase('filter: tick ERROR + Apply', async () => {
    await click(`[...document.querySelectorAll('fieldset label')].find((l) => /ERROR/.test(l.textContent)).querySelector('input')`);
    await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apply')`);
  }, { done: `/Level: ERROR/.test(document.body.innerText) && /Page 1 of/.test((document.querySelector('.page-info')||{}).innerText||'')` }));
  await shot('logs-filtered');
  ix.push(await phase('typing: "timeout" (text)', async () => { await focus('input[aria-label="Search logs"]'); await typeText('timeout'); }, { done: `/Text: timeout/.test(document.body.innerText)` }));
  ix.push(await phase('typing: clear + "pago" + Enter', async () => {
    await evalJs(`(() => { const el = document.querySelector('input[aria-label="Search logs"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await typeText('pago');
  }, { done: `/Text: pago/.test(document.body.innerText)` }));
  ix.push(await phase('regex: on + type Timeout.*pool', async () => {
    await click(`[...document.querySelectorAll('label')].find((l) => /Regex/.test(l.textContent)).querySelector('input')`);
    await evalJs(`(() => { const el = document.querySelector('input[aria-label="Search logs"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await focus('input[aria-label="Search logs"]');
    await typeText('Timeout.*pool');
  }, { done: `/Regex: Timeout/.test(document.body.innerText) && document.querySelector('table.data tbody tr')` }));
  await shot('logs-regex');
  ix.push(await phase('reset filters', () => click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reset')`), { done: `!/Regex: Timeout/.test(document.body.innerText) && document.querySelector('table.data tbody tr')` }));
  void before;

  // ---- Dashboard and Alerts once
  for (const [name, route, ready] of [
    ['dashboard', '/', `document.querySelector('[data-testid="dash-widgets"]') && document.querySelectorAll('[data-testid="dash-widgets"] > [data-widget]').length >= 3`],
    ['alerts', '/alerts', `document.querySelector('table.data tbody tr')`],
  ]) {
    await nav(route);
    const t = performance.now();
    const ok = await waitFor_(ready);
    const readyMs = ok ? Math.round(performance.now() - t) + 300 : null;
    await settle(1000);
    const lts = await evalJs('window.__perf.longtasks');
    const mm = await metrics();
    result.pages[name] = { readyMs, longTasks: lts.length, longTaskMaxMs: lts.reduce((a, x) => Math.max(a, x.duration), 0), domNodes: await domNodes(), heapMb: +(mm.JSHeapUsedSize / 1048576).toFixed(1) };
    log(`${name.padEnd(10)} ready ~${readyMs} ms, long tasks ${lts.length} (max ${result.pages[name].longTaskMaxMs} ms), dom ${result.pages[name].domNodes}`);
    await shot(name);
  }

  // ---- Heap growth: repeat a filter cycle 15 times on /logs, GC, compare.
  await nav('/logs');
  await waitFor_('window.__perf && window.__perf.firstRows !== null');
  await settle(800);
  await gc();
  const heapA = (await metrics()).JSHeapUsedSize / 1048576;
  for (let i = 0; i < 15; i++) {
    await click('document.querySelector(\'button[aria-label="Next page"]\')');
    await sleep(150);
    await click('document.querySelector(\'button[aria-label="Previous page"]\')');
    await sleep(150);
    await click(`[...document.querySelectorAll('button')].find((b) => /^Sort:/.test(b.textContent.trim()))`);
    await sleep(200);
  }
  await settle(800);
  await gc();
  const heapB = (await metrics()).JSHeapUsedSize / 1048576;
  result.heap = { afterLoadMb: +heapA.toFixed(1), afterCyclesMb: +heapB.toFixed(1), growthMb: +(heapB - heapA).toFixed(1), note: '15 x (next, prev, toggle sort) with a forced GC before and after' };
  log(`heap after GC: ${result.heap.afterLoadMb} -> ${result.heap.afterCyclesMb} MB`);

  if (bg) { log('waiting for background load to finish'); await new Promise((r) => bg.on('exit', r)); }
  if (process.env.UI_PERF_BG === '1') {
    try { const s = JSON.parse(fs.readFileSync(path.join(OUT, 'background-load', 'summary.json'), 'utf8')); result.backgroundSummary = { overall: s.overall, groups: s.groups }; } catch { /* no summary */ }
  }

  // ---- verdicts (DRAFT placeholders)
  const maxInteractionLongTask = Math.max(0, ...ix.map((i) => i.longTaskMaxMs));
  const maxHeap = Math.max(result.heap.afterCyclesMb, ...Object.values(result.pages).map((p) => p.heapMb), ...ix.map((i) => i.heapMb));
  const maxDom = Math.max(result.pages.logs.domNodes, ...ix.map((i) => i.domNodes));
  const checks = [
    ['logs first rows (ms)', result.pages.logs.firstRowsMs, LIMITS.firstRowsMs],
    ['max long task during interaction (ms)', maxInteractionLongTask, LIMITS.longTaskMs],
    ['max JS heap (MB)', maxHeap, LIMITS.heapMb],
    ['max DOM nodes on Logs', maxDom, LIMITS.logsDomNodes],
  ].map(([metric, actual, limit]) => ({ metric, actual, limit, ok: actual !== null && actual <= limit }));
  result.verdict = { status: 'DRAFT thresholds, placeholders pending Urbani (client input #14)', ok: checks.every((c) => c.ok), checks };
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(result, null, 2));
  console.log('\n' + checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.metric.padEnd(40)} actual ${String(c.actual).padStart(6)} limit ${c.limit}`).join('\n'));
  log(`wrote ${path.join(OUT, 'perf.json')}`);
  cdp.close();
  return result.verdict.ok;
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error(`[ui-perf] FAILED: ${e.stack ?? e.message}`);
} finally {
  killAll();
}
process.exit(ok || process.env.UI_PERF_NOFAIL === '1' ? 0 : 1);
