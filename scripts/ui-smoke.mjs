#!/usr/bin/env node
/**
 * Browser-level UI smoke test (DPI 2, dev-only). NO dependencies: Node 24 built-ins + Microsoft Edge/Chrome driven
 * over the Chrome DevTools Protocol (CDP) with Node's global WebSocket and fetch.
 *
 *   npm run build            # once: the smoke starts the compiled backend (packages/backend/dist)
 *   node scripts/ui-smoke.mjs
 *
 * What it does
 *   1. Starts the backend (port 4100, INTEGRATION_MODE=mock, worktree-local SQLite under .tmp/ui-smoke, freshly
 *      migrated + seeded) and the Vite dev server (port 5273, /api proxied to 4100).
 *   2. Launches headless Edge (or Chrome) with --remote-debugging-port and logs in as the seeded admin through the UI.
 *   3. Visits every route in LIGHT then DARK theme, opens the Copilot widget and its History panel, takes a full-page
 *      PNG per route/theme and records console errors/warnings, page exceptions and failed network requests.
 *   4. Writes .tmp/ui-smoke/summary.json, prints a table, exits 1 if any page threw a console error / exception,
 *      rendered blank, showed an error overlay, got a 5xx, or did not apply the requested theme.
 *   Everything it starts is killed in a finally block (also on failure / Ctrl+C).
 *
 * Environment overrides: SMOKE_BROWSER (path to msedge/chrome), SMOKE_BACKEND_PORT (4100), SMOKE_FRONTEND_PORT (5273),
 * SMOKE_CDP_PORT (9333), SMOKE_ONLY (comma-separated route names to run).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.tmp', 'ui-smoke');
const BACKEND_PORT = Number(process.env.SMOKE_BACKEND_PORT ?? 4100);
const FRONTEND_PORT = Number(process.env.SMOKE_FRONTEND_PORT ?? 5273);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT ?? 9333);
const BASE = `http://127.0.0.1:${FRONTEND_PORT}`;
const API = `http://127.0.0.1:${BACKEND_PORT}`;
const ADMIN = { email: 'admin@urbani.local', password: 'SmokeTest-Passw0rd!' };
const THEMES = ['light', 'dark'];
const BROWSER_CANDIDATES = [
  process.env.SMOKE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
/** 4xx answers that are normal for this app (reported, not failed). */
const EXPECTED_STATUS = [/\/favicon/];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const log = (m) => console.log(`[ui-smoke] ${m}`);

function start(name, cmd, args, opts = {}) {
  const logFile = path.join(OUT, `${name}.log`);
  const out = fs.openSync(logFile, 'w');
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
    } catch {
      /* already gone */
    }
    log(`stopped ${name}`);
  }
}

async function waitFor(url, label, timeoutMs = 60_000, ok = (r) => r.ok) {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (ok(r)) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.cause?.code ?? e.message;
    }
    await sleep(400);
  }
  throw new Error(`${label} did not become ready (${last}) at ${url}`);
}

// ---------------------------------------------------------------- minimal CDP client
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {});
      }
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
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000).unref?.();
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- page driver
class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.reset();
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning' || p.type === 'assert') {
        const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300);
        (p.type === 'warning' ? this.current.warnings : this.current.errors).push(text);
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      this.current.exceptions.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').split('\n')[0].slice(0, 300));
    });
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry;
      if (e.source === 'network') return; // the same failure is recorded from the Network domain
      if (e.level === 'error') this.current.errors.push(`${e.source}: ${e.text}`.slice(0, 300));
      else if (e.level === 'warning') this.current.warnings.push(`${e.source}: ${e.text}`.slice(0, 300));
    });
    cdp.on('Network.requestWillBeSent', (p) => {
      this.inflight.add(p.requestId);
      this.urls.set(p.requestId, p.request.url);
      this.lastNetworkActivity = Date.now();
    });
    cdp.on('Network.responseReceived', (p) => {
      const url = p.response.url;
      if (p.response.status >= 400 && !EXPECTED_STATUS.some((re) => re.test(url))) {
        this.current.failed.push({ status: p.response.status, url: this.label(url) });
      }
    });
    cdp.on('Network.loadingFinished', (p) => {
      this.inflight.delete(p.requestId);
      this.lastNetworkActivity = Date.now();
    });
    cdp.on('Network.loadingFailed', (p) => {
      this.inflight.delete(p.requestId);
      this.lastNetworkActivity = Date.now();
      if (p.canceled) return;
      const url = this.urls.get(p.requestId) ?? '?';
      const external = !url.startsWith(BASE) && !url.startsWith(API);
      (external ? this.current.external : this.current.failed).push({ status: 0, url: this.label(url), error: p.errorText });
    });
  }
  reset() {
    this.inflight = new Set();
    this.urls = new Map();
    this.lastNetworkActivity = Date.now();
    this.current = { errors: [], warnings: [], exceptions: [], failed: [], external: [] };
  }
  label(url) {
    try {
      const u = new URL(url);
      return `${u.pathname}`;
    } catch {
      return url.slice(0, 80);
    }
  }
  async init() {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Log.enable');
    await this.cdp.send('Network.enable');
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  async eval(expression) {
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async setStorage(entries) {
    if (this.initScript) await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.initScript });
    const src = Object.entries(entries).map(([k, v]) => `try{localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})}catch(e){}`).join(';');
    this.initScript = (await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src })).identifier;
  }
  async goto(pathname) {
    this.reset();
    await this.cdp.send('Page.navigate', { url: `${BASE}${pathname}` });
    await this.settle();
  }
  /** Waits until the network has been quiet for 700 ms (max 12 s), then lets charts / animations finish. */
  async settle(maxMs = 12_000) {
    const end = Date.now() + maxMs;
    await sleep(500);
    while (Date.now() < end) {
      if (this.inflight.size === 0 && Date.now() - this.lastNetworkActivity > 700) break;
      await sleep(150);
    }
    await sleep(500);
  }
  async screenshot(file) {
    const m = await this.cdp.send('Page.getLayoutMetrics');
    const size = m.cssContentSize ?? m.contentSize;
    const height = Math.min(Math.ceil(size.height), 6000);
    const shot = await this.cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height, scale: 1 },
    });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }
  /** Facts about what is on screen: used for the blank / overlay / theme assertions. */
  inspect() {
    return this.eval(`(() => {
      const root = document.getElementById('root');
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(bg) || [0, 255, 255, 255];
      const lum = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
      return {
        title: document.title,
        path: location.pathname,
        chars: (root ? root.innerText : '').trim().length,
        children: root ? root.children.length : 0,
        overlay: !!document.querySelector('vite-error-overlay'),
        dataTheme: document.documentElement.getAttribute('data-theme'),
        bgLuminance: Math.round(lum * 100) / 100,
        h1: (document.querySelector('h1') || {}).innerText || '',
        forbidden: /do not have permission/i.test(document.body.innerText),
      };
    })()`);
  }
}

// ---------------------------------------------------------------- main
async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const dist = path.join(ROOT, 'packages', 'backend', 'dist', 'server.js');
  if (!fs.existsSync(dist)) throw new Error('packages/backend/dist is missing: run `npm run build` first');
  const browser = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browser) throw new Error(`No Edge/Chrome found (tried ${BROWSER_CANDIDATES.join('; ')}); set SMOKE_BROWSER`);
  log(`browser: ${browser}`);
  // Never talk to (or kill the wrong) server: every port must be free before we start.
  for (const port of [BACKEND_PORT, FRONTEND_PORT, CDP_PORT]) {
    const busy = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    if (busy) throw new Error(`port ${port} is already in use; stop that process first`);
  }

  // 1. Backend: fresh worktree-local SQLite database, migrated and seeded; mock integrations.
  const dbFile = path.join(OUT, 'urbani-smoke.sqlite');
  const env = {
    NODE_ENV: 'development',
    PORT: String(BACKEND_PORT),
    INTEGRATION_MODE: 'mock',
    DB_DRIVER: 'sqlite',
    DATABASE_URL: dbFile,
    JWT_SECRET: 'ui-smoke-secret-not-for-production',
    SEED_ADMIN_EMAIL: ADMIN.email,
    SEED_ADMIN_PASSWORD: ADMIN.password,
    LOG_LEVEL: 'warn',
    RATE_LIMIT_DISABLED: '1',
    HEALTH_PROBE_INTERVAL_SECONDS: '10',
    URBANI_API_BASE_URL: '',
    URBANI_API_KEY: '',
  };
  for (const script of ['migrate.js', 'seed.js']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'packages', 'backend', 'dist', 'db', script)], { cwd: path.join(ROOT, 'packages', 'backend'), env: { ...process.env, ...env }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  }
  start('backend', process.execPath, [dist], { cwd: path.join(ROOT, 'packages', 'backend'), env });
  await waitFor(`${API}/api/health`, 'backend');
  log(`backend ready on ${BACKEND_PORT}`);

  // 2. Vite dev server proxying /api to the backend.
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  start('vite', process.execPath, [vite, '--port', String(FRONTEND_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(ROOT, 'packages', 'frontend'),
    env: { VITE_DEV_PORT: String(FRONTEND_PORT), VITE_DEV_API_PORT: String(BACKEND_PORT), FORCE_COLOR: '0' },
  });
  await waitFor(`${BASE}/`, 'vite dev server');
  log(`frontend ready on ${FRONTEND_PORT}`);

  // 3. Browser.
  start('browser', browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars=false', '--window-size=1440,900', 'about:blank',
  ]);
  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 'browser debugging endpoint');
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('browser has no page target');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const page = new Page(cdp);
  await page.init();

  const results = [];
  const shotPath = (name, theme) => path.join(OUT, `${name}.${theme}.png`);
  const record = async (name, route, theme, extra = {}) => {
    const facts = await page.inspect();
    const c = page.current;
    const problems = [];
    if (c.errors.length) problems.push(`${c.errors.length} console error(s)`);
    if (c.exceptions.length) problems.push(`${c.exceptions.length} page exception(s)`);
    if (facts.overlay) problems.push('error overlay');
    if (facts.chars < 40 || facts.children === 0) problems.push(`blank page (${facts.chars} chars)`);
    if (c.failed.some((f) => f.status >= 500 || f.status === 0)) problems.push('5xx / failed request');
    if (facts.dataTheme !== theme) problems.push(`theme not applied (data-theme=${facts.dataTheme})`);
    if (theme === 'dark' && facts.bgLuminance > 0.25) problems.push(`body background is light in dark theme (${facts.bgLuminance})`);
    if (theme === 'light' && facts.bgLuminance < 0.6) problems.push(`body background is dark in light theme (${facts.bgLuminance})`);
    if (extra.expectPath && !facts.path.startsWith(extra.expectPath)) problems.push(`redirected to ${facts.path}`);
    if (facts.forbidden) problems.push('permission screen shown to the admin');
    const file = shotPath(name, theme);
    await page.screenshot(file);
    results.push({
      name, route, theme, finalPath: facts.path, heading: facts.h1, chars: facts.chars,
      consoleErrors: c.errors, consoleWarnings: c.warnings, exceptions: c.exceptions,
      failedRequests: c.failed, externalFailures: c.external,
      problems, status: problems.length ? 'FAIL' : 'PASS', screenshot: path.relative(ROOT, file),
    });
    log(`${problems.length ? 'FAIL' : 'ok  '} ${name.padEnd(16)} ${theme.padEnd(5)} ${problems.join('; ')}`);
  };

  // 4. Log in through the UI (light), screenshot the login page in both themes first.
  await page.setStorage({ 'urbani.theme': 'light' });
  await page.goto('/login');
  await record('login', '/login', 'light');
  await page.setStorage({ 'urbani.theme': 'dark' });
  await page.goto('/login');
  await record('login', '/login', 'dark');
  await page.setStorage({ 'urbani.theme': 'light' });
  await page.goto('/login');
  await page.eval(`(async () => {
    const set = (id, v) => { const el = document.getElementById(id); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('email', ${JSON.stringify(ADMIN.email)});
    set('password', ${JSON.stringify(ADMIN.password)});
    document.querySelector('button.login-submit').click();
  })()`);
  const loginDeadline = Date.now() + 15_000;
  let token = null;
  while (Date.now() < loginDeadline && !token) {
    await sleep(300);
    token = await page.eval(`localStorage.getItem('urbani.token')`);
  }
  if (!token) throw new Error('UI login did not produce a session token');
  await page.settle();
  log('logged in through the UI as the seeded admin');

  // An alert id for the detail page.
  const alerts = await (await fetch(`${API}/api/alerts?pageSize=1`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const alertId = alerts?.data?.items?.[0]?.alertId;
  const routes = [
    ['dashboard', '/'],
    ['alerts', '/alerts'],
    ...(alertId ? [['alert-detail', `/alerts/${encodeURIComponent(alertId)}`]] : []),
    ['logs', '/logs'],
    ['audit', '/audit'],
    ['users', '/users'],
    ['notifications', '/notifications'],
    ['security', '/security'],
    ['health', '/health'],
    ['ai-insights', '/ai'],
    ['metrics', '/metrics'],
    ['services', '/services'],
    ['usage', '/usage'],
    ['settings', '/settings'],
    ['assistant', '/assistant'],
  ];
  const only = process.env.SMOKE_ONLY ? new Set(process.env.SMOKE_ONLY.split(',')) : null;

  for (const theme of THEMES) {
    // The server-side preference wins over localStorage after login, so set both.
    await fetch(`${API}/api/preferences`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) });
    await page.setStorage({ 'urbani.theme': theme, 'urbani.token': token });
    for (const [name, route] of routes) {
      if (only && !only.has(name)) continue;
      await page.goto(route);
      await record(name, route, theme, { expectPath: route.split('?')[0] });
    }
    // Copilot widget + History panel (on the dashboard).
    await page.goto('/');
    const opened = await page.eval(`(() => { const b = document.querySelector('button.assistant-launcher'); if (!b) return false; b.click(); return true; })()`);
    if (!opened) {
      results.push({ name: 'copilot-widget', route: '/', theme, problems: ['launcher button not found'], status: 'FAIL', consoleErrors: [], consoleWarnings: [], exceptions: [], failedRequests: [], externalFailures: [] });
      log(`FAIL copilot-widget  ${theme} launcher button not found`);
    } else {
      await page.settle(6000);
      const hasPanel = await page.eval(`!!document.querySelector('.assistant-panel')`);
      await record('copilot-widget', '/', theme);
      if (!hasPanel) results[results.length - 1].problems.push('panel did not open'), (results[results.length - 1].status = 'FAIL');
      const history = await page.eval(`(() => { const b = document.querySelector('button[aria-label="Conversation history"]'); if (!b) return false; b.click(); return true; })()`);
      if (history) {
        await page.settle(6000);
        await record('copilot-history', '/', theme);
      } else {
        results.push({ name: 'copilot-history', route: '/', theme, problems: ['history button not found'], status: 'FAIL', consoleErrors: [], consoleWarnings: [], exceptions: [], failedRequests: [], externalFailures: [] });
        log(`FAIL copilot-history ${theme} history button not found`);
      }
    }
  }

  // 4b. Exports (DPI 2 item 11) and dashboard personalisation (item 12).
  const authHeaders = { Authorization: `Bearer ${token}` };
  const check = (name, theme, problems) => {
    results.push({ name, route: '', theme, problems, status: problems.length ? 'FAIL' : 'PASS', consoleErrors: [], consoleWarnings: [], exceptions: [], failedRequests: [], externalFailures: [] });
    log(`${problems.length ? 'FAIL' : 'ok  '} ${name.padEnd(22)} ${problems.join('; ')}`);
  };
  /** Fetch a file inside the page (same origin, same proxy) and describe it. */
  const fetchInfo = (url) => page.eval(`(async () => {
    const r = await fetch(${JSON.stringify(url)}, { headers: { Authorization: 'Bearer ' + localStorage.getItem('urbani.token') } });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), size: buf.length, disposition: r.headers.get('content-disposition'),
      rows: r.headers.get('x-export-rows'), head: Array.from(buf.slice(0, 80)), tail: Array.from(buf.slice(-8)) };
  })()`);
  const text = (bytes) => Buffer.from(bytes).toString('utf8');
  const clickAria = (label) => page.eval(`(() => { const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  const clickText = (txt) => page.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(txt)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  const order = () => page.eval(`[...document.querySelectorAll('[data-testid="dash-widgets"] > [data-widget]')].map((e) => e.getAttribute('data-widget'))`);
  const getLayout = async () => (await (await fetch(`${API}/api/preferences`, { headers: authHeaders })).json()).data.widgetLayout;

  if (!only) {
    await page.setStorage({ 'urbani.theme': 'dark', 'urbani.token': token });
    await page.goto('/logs');
    const exportProblems = [];
    const menu = await page.eval(`(() => { const b = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((x) => /Export/.test(x.textContent)); if (!b) return null; b.click(); return true; })()`);
    if (!menu) exportProblems.push('Logs Export menu missing');
    else {
      await sleep(200);
      const items = await page.eval(`[...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim())`);
      if (items.join(',') !== 'CSV,JSON,PDF') exportProblems.push(`menu items: ${items.join(',')}`);
      await page.eval(`[...document.querySelectorAll('[role="menuitem"]')][0].click()`); // real UI download path (CSV)
      await sleep(1500);
      const msg = await page.eval(`(document.querySelector('.export-menu-msg') || {}).innerText || ''`);
      if (!/urbani-logs-\d{8}-\d{6}\.csv downloaded/.test(msg)) exportProblems.push(`no download confirmation in the UI: "${msg}"`);
    }
    await record('logs-export-menu', '/logs', 'dark');
    const csv = await fetchInfo('/api/logs/export?format=csv');
    if (csv.status !== 200 || !/text\/csv/.test(csv.type)) exportProblems.push(`csv status/type ${csv.status} ${csv.type}`);
    else if (!text(csv.head).replace(/^\uFEFF/, '').startsWith('timestamp,level,service,environment,message,id') || csv.size < 200) exportProblems.push('csv header row missing or file too small');
    const json = await fetchInfo('/api/logs/export?format=json&levels=ERROR');
    if (json.status !== 200 || !/application\/json/.test(json.type) || !text(json.head).startsWith('{"meta":')) exportProblems.push(`json ${json.status} ${json.type}`);
    const pdf = await fetchInfo('/api/logs/export?format=pdf');
    if (pdf.status !== 200 || pdf.type !== 'application/pdf' || text(pdf.head.slice(0, 5)) !== '%PDF-' || !text(pdf.tail).includes('%%EOF') || pdf.size < 1500) exportProblems.push(`pdf ${pdf.status} ${pdf.type} ${pdf.size}B`);
    check('logs-export', 'dark', exportProblems);
    log(`      csv ${csv.size}B rows=${csv.rows}, json ${json.size}B, pdf ${pdf.size}B`);

    // Alerts export + incident report
    const alertProblems = [];
    await page.goto('/alerts');
    const aMenu = await page.eval(`!![...document.querySelectorAll('button[aria-haspopup="menu"]')].find((x) => /Export/.test(x.textContent))`);
    if (!aMenu) alertProblems.push('Alerts Export menu missing');
    const aCsv = await fetchInfo('/api/alerts/export?format=csv');
    if (aCsv.status !== 200 || !text(aCsv.head).replace(/^\uFEFF/, '').startsWith('alertId,timestamp,service')) alertProblems.push(`alerts csv ${aCsv.status}`);
    const aJson = await fetchInfo('/api/alerts/export?format=json');
    if (aJson.status !== 200 || !/application\/json/.test(aJson.type)) alertProblems.push(`alerts json ${aJson.status}`);
    if (alertId) {
      await page.goto(`/alerts/${encodeURIComponent(alertId)}`);
      const dl = await page.eval(`!![...document.querySelectorAll('button')].find((x) => /Download incident report/.test(x.textContent))`);
      if (!dl) alertProblems.push('incident report button missing');
      const rep = await fetchInfo(`/api/alerts/${encodeURIComponent(alertId)}/report?format=pdf`);
      if (rep.status !== 200 || rep.type !== 'application/pdf' || text(rep.head.slice(0, 5)) !== '%PDF-' || !text(rep.tail).includes('%%EOF')) alertProblems.push(`incident pdf ${rep.status} ${rep.type}`);
      const nf = await fetchInfo('/api/alerts/nope/report?format=pdf');
      if (nf.status !== 404) alertProblems.push(`unknown incident gave ${nf.status}, expected 404`);
    }
    check('alerts-export-report', 'dark', alertProblems);

    // Dashboard customize flow
    const dashProblems = [];
    await fetch(`${API}/api/preferences`, { method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ widgetLayout: null }) });
    await page.eval(`Object.keys(localStorage).filter((k) => k.startsWith('urbani.dashboardLayout.')).forEach((k) => localStorage.removeItem(k))`);
    await page.goto('/');
    const order0 = await order();
    if (order0.length < 5) dashProblems.push(`default dashboard has ${order0.length} widgets`);
    if (!(await clickAria('Customize dashboard'))) dashProblems.push('Customize button missing');
    await sleep(300);
    if (!(await clickAria('Move Service health down'))) dashProblems.push('move button missing');
    await sleep(200);
    const live = await page.eval(`document.querySelector('[data-testid="dash-live"]').innerText`);
    if (!/Service health moved to position 3 of \d+/.test(live)) dashProblems.push(`live region says "${live}"`);
    const moved = await order();
    if (moved[2] !== 'service-health' || moved[1] !== order0[2] || moved[0] !== order0[0]) dashProblems.push(`order after move: ${moved.join(',')}`);
    if (!(await clickAria('Hide AI cost & budget'))) dashProblems.push('hide button missing');
    await sleep(200);
    const trayHas = await page.eval(`!!document.querySelector('button[aria-label="Show AI cost & budget"]')`);
    if (!trayHas) dashProblems.push('hidden widget not in the tray');
    if (!(await page.eval(`/Unsaved changes/.test(document.body.innerText)`))) dashProblems.push('no unsaved-changes indicator');
    await record('dashboard-customize', '/', 'dark');
    if (!(await clickText('Save'))) dashProblems.push('Save button missing');
    await sleep(1200);
    const savedLayout = await getLayout();
    if (!savedLayout || savedLayout.widgets.find((w) => w.id === 'ai-cost')?.visible !== false) dashProblems.push('server layout does not have ai-cost hidden');
    await page.goto('/'); // reload: the saved layout must persist
    const afterReload = await order();
    if (afterReload.join(',') !== moved.filter((x) => x !== 'ai-cost').join(',')) dashProblems.push(`after reload: ${afterReload.join(',')}`);
    if (afterReload.includes('ai-cost')) dashProblems.push('hidden widget visible after reload');
    // light mode, customize view
    await fetch(`${API}/api/preferences`, { method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'light' }) });
    await page.setStorage({ 'urbani.theme': 'light', 'urbani.token': token });
    await page.goto('/');
    await clickAria('Customize dashboard');
    await sleep(300);
    await record('dashboard-customize', '/', 'light');
    // narrow viewport: reorder with buttons still works
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: true });
    await sleep(400);
    const narrowOk = await page.eval(`!!document.querySelector('button[aria-label="Move Recent alerts up"]') && document.documentElement.scrollWidth <= window.innerWidth + 4`);
    if (!narrowOk) dashProblems.push('narrow viewport: move buttons missing or horizontal overflow');
    await page.screenshot(path.join(OUT, 'dashboard-customize.narrow.png'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // reset to default
    if (!(await clickText('Reset to default'))) dashProblems.push('Reset button missing');
    await sleep(1200);
    if ((await getLayout()) !== null) dashProblems.push('reset did not clear the server layout');
    await page.goto('/');
    const afterReset = await order();
    if (afterReset.join(',') !== order0.join(',')) dashProblems.push(`after reset: ${afterReset.join(',')}`);
    check('dashboard-customize-flow', 'light', dashProblems);
    await fetch(`${API}/api/preferences`, { method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'dark' }) });
  }

  // 5. Theme toggle: operable by keyboard / click, sets data-theme, persists to localStorage and the API.
  await page.setStorage({ 'urbani.theme': 'light', 'urbani.token': token });
  await fetch(`${API}/api/preferences`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'light' }) });
  await page.goto('/');
  const toggle = await page.eval(`(async () => {
    const btn = [...document.querySelectorAll('.theme-toggle button')].find((b) => b.getAttribute('aria-label') === 'Dark theme');
    if (!btn) return { found: false };
    btn.focus(); btn.click();
    await new Promise((r) => setTimeout(r, 800));
    return {
      found: true,
      dataTheme: document.documentElement.getAttribute('data-theme'),
      stored: localStorage.getItem('urbani.theme'),
      pressed: btn.getAttribute('aria-pressed'),
    };
  })()`);
  const prefs = await (await fetch(`${API}/api/preferences`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const toggleProblems = [];
  if (!toggle.found) toggleProblems.push('theme toggle not found');
  else {
    if (toggle.dataTheme !== 'dark') toggleProblems.push(`toggle did not switch the theme (${toggle.dataTheme})`);
    if (toggle.stored !== 'dark') toggleProblems.push('toggle did not persist to localStorage');
    if (toggle.pressed !== 'true') toggleProblems.push('aria-pressed not updated');
    if (prefs?.data?.theme !== 'dark') toggleProblems.push(`preference not saved to the API (${prefs?.data?.theme})`);
  }
  results.push({ name: 'theme-toggle', route: '/', theme: 'light->dark', problems: toggleProblems, status: toggleProblems.length ? 'FAIL' : 'PASS', consoleErrors: [], consoleWarnings: [], exceptions: [], failedRequests: [], externalFailures: [] });
  log(`${toggleProblems.length ? 'FAIL' : 'ok  '} theme-toggle ${toggleProblems.join('; ')}`);

  cdp.close();
  return results;
}

function printTable(results) {
  const rows = results.map((r) => [
    r.name, r.theme, r.status,
    String(r.consoleErrors.length + r.exceptions.length), String(r.consoleWarnings.length),
    String(r.failedRequests.length), r.problems.join('; ') || '-',
  ]);
  const head = ['page', 'theme', 'result', 'errors', 'warnings', 'failed req', 'problems'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n${line(head)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  rows.forEach((r) => console.log(line(r)));
}

let results = [];
let exitCode = 0;
process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});
try {
  results = await main();
} catch (err) {
  console.error(`[ui-smoke] ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 2;
} finally {
  killAll();
}
if (results.length) {
  printTable(results);
  const failed = results.filter((r) => r.status === 'FAIL');
  const warnings = results.reduce((n, r) => n + r.consoleWarnings.length, 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    browser: BROWSER_CANDIDATES.find((p) => fs.existsSync(p)) ?? null,
    pages: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    consoleWarnings: warnings,
    results,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed}/${summary.pages} checks passed, ${failed.length} failed, ${warnings} console warning(s). Screenshots + summary.json: ${path.relative(ROOT, OUT)}`);
  for (const r of failed) console.log(`  FAIL ${r.name} (${r.theme}): ${r.problems.join('; ')}${r.consoleErrors[0] ? ` | first error: ${r.consoleErrors[0]}` : ''}${r.exceptions[0] ? ` | exception: ${r.exceptions[0]}` : ''}`);
  if (failed.length) exitCode = 1;
}
process.exit(exitCode);
