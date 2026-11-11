#!/usr/bin/env node
/**
 * Live-mode rehearsal (dev only). Runs the REAL compiled backend with INTEGRATION_MODE=live against a FAKE Urbani QA API
 * (scripts/fake-urbani-api.mjs), so the live adapters, the alert sync, the notification engine and the failure paths are
 * exercised end to end with no access to Urbani or AWS.
 *
 *   npm run build                                   # once: runs packages/backend/dist
 *   node scripts/rehearse-live.mjs                  # notifications in DRY-RUN
 *   SNS_ENDPOINT=http://127.0.0.1:5000 node scripts/rehearse-live.mjs     # e-mail through a local SNS emulator (moto)
 *
 * What it proves: live logs / alerts / chat are served with source LIVE and never leak the API key; a new upstream alert
 * becomes ONE notification; raising its severity produces exactly one [ESCALATED] follow-up; an upstream outage degrades
 * honestly (stale data, chat 503) and recovers. What it does NOT prove: anything about the real Urbani API or real AWS.
 * Uses ports 4200 (backend) and 4300 (fake upstream). Everything it starts is stopped at the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFakeUrbani } from './fake-urbani-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp', 'rehearse-live');
const API_PORT = Number(process.env.REHEARSE_BACKEND_PORT ?? 4200);
const FAKE_PORT = Number(process.env.REHEARSE_FAKE_PORT ?? 4300);
const KEY = 'rehearsal-api-key-0123456789abcdef';
const ADMIN = { email: 'admin@urbani.local', password: 'Rehearsal-Passw0rd!' };
const BASE = `http://127.0.0.1:${API_PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const SNS_ENDPOINT = process.env.SNS_ENDPOINT;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 150_000, everyMs = 5_000, label = '' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  return null;
}
let token = '';
const api = async (method, p, body) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};
const control = (p, body) => fetch(`${FAKE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const dist = path.join(ROOT, 'packages', 'backend', 'dist', 'server.js');
  if (!fs.existsSync(dist)) throw new Error('packages/backend/dist is missing: run npm run build first');

  // ---- fake upstream ----
  const fake = createFakeUrbani({ key: KEY });
  await new Promise((r) => fake.server.listen(FAKE_PORT, '127.0.0.1', r));
  await control('/__alert', { service: 'main', alert_id: 'REHEARSAL-ALERT-1', severity: 'HIGH', anomaly_type: 'ElevatedErrorRate' });

  // ---- optional SNS emulator topic ----
  const env = {
    ...process.env,
    NODE_ENV: 'development', LOG_LEVEL: 'warn', PORT: String(API_PORT),
    DB_DRIVER: 'sqlite', DATABASE_URL: path.join(TMP, 'rehearse.sqlite'),
    JWT_SECRET: 'rehearsal-jwt-secret-not-for-production-0123456789', SEED_ADMIN_EMAIL: ADMIN.email, SEED_ADMIN_PASSWORD: ADMIN.password,
    INTEGRATION_MODE: 'live', URBANI_API_BASE_URL: FAKE, URBANI_API_KEY: KEY, URBANI_SERVICES: 'main,payments', URBANI_SERVICE: 'main',
    URBANI_REFRESH_MINUTES: '1', URBANI_ENVIRONMENT: 'qa',
    NOTIFICATIONS_ENABLED: 'true', ALERT_POLL_MINUTES: '1', NOTIFICATIONS_MAX_ALERT_AGE_MINUTES: '120',
    HEALTH_PROBES_ENABLED: 'false', AUDIT_RETENTION_JOB: 'false',
  };
  let channel = 'EMAIL';
  if (SNS_ENDPOINT) {
    const requireFromBackend = createRequire(path.join(ROOT, 'packages', 'backend', 'package.json'));
    const { SNSClient, CreateTopicCommand } = requireFromBackend('@aws-sdk/client-sns');
    const sns = new SNSClient({ region: 'us-east-1', endpoint: SNS_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    const topic = await sns.send(new CreateTopicCommand({ Name: 'urbani-rehearsal' }));
    Object.assign(env, { AWS_ENDPOINT_URL_SNS: SNS_ENDPOINT, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1', ALERT_SNS_TOPIC_ARN: topic.TopicArn });
    console.log(`e-mail channel: real AWS SDK -> SNS emulator ${SNS_ENDPOINT}`);
  } else {
    env.NOTIFICATIONS_DRY_RUN = 'true';
    console.log('e-mail channel: DRY-RUN (set SNS_ENDPOINT to send through an SNS emulator)');
  }

  const seed = spawnSync(process.execPath, [path.join(ROOT, 'packages', 'backend', 'dist', 'db', 'seed.js')], { env, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr || seed.stdout}`);
  const backend = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let backendOut = '';
  backend.stdout.on('data', (d) => (backendOut += d));
  backend.stderr.on('data', (d) => (backendOut += d));
  const stop = () => { try { backend.kill(); } catch { /* ignore */ } try { fake.server.close(); } catch { /* ignore */ } };
  process.on('SIGINT', () => { stop(); process.exit(130); });

  try {
    const up = await waitFor(async () => { try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; } }, { timeoutMs: 60_000, everyMs: 1_000 });
    check('backend starts in INTEGRATION_MODE=live', Boolean(up));
    if (!up) throw new Error(`backend did not start:\n${backendOut.slice(-1500)}`);

    const login = await api('POST', '/api/auth/login', ADMIN);
    token = login.json?.token ?? '';
    check('sign in as the seeded admin', login.status === 200 && Boolean(token));

    // ---- 1. live reads ----
    const alerts = await api('GET', '/api/alerts?pageSize=50');
    const ids = (alerts.json?.data?.items ?? []).map((a) => a.alertId);
    check('alerts are served with source LIVE', alerts.status === 200 && alerts.json?.source === 'LIVE', `source=${alerts.json?.source}`);
    check('the upstream alert appears in the dashboard', ids.includes('REHEARSAL-ALERT-1'), `ids=${ids.join(',') || 'none'}`);

    const logs = await api('GET', '/api/logs?service=main&pageSize=50');
    check('logs are served with source LIVE and contain the upstream line', logs.status === 200 && logs.json?.source === 'LIVE' && logs.text.includes('FAKE-LINE'), `source=${logs.json?.source}`);

    const chat = await api('POST', '/api/chat', { question: 'What failed in the last 5 minutes?', service: 'main' });
    check('chat answers come from the upstream /chat (no mock fallback)', chat.status === 200 && chat.text.includes('FAKE answer'), `status=${chat.status}`);

    const leak = [alerts.text, logs.text, chat.text].some((t) => t.includes(KEY));
    check('the upstream API key never appears in any API response', !leak);

    // ---- 2. notification for a new alert ----
    const notified = await waitFor(async () => {
      await api('GET', '/api/alerts?pageSize=5'); // an Alerts page load also triggers the engine after a live sync
      const log = await api('GET', `/api/notifications/log?alertId=REHEARSAL-ALERT-1&channel=${channel}&pageSize=20`);
      const items = log.json?.data?.items ?? [];
      return items.length ? items : null;
    }, { timeoutMs: 120_000, everyMs: 5_000 });
    const expectedStatus = SNS_ENDPOINT ? 'SENT' : 'DRY_RUN';
    check(`new upstream alert -> exactly one ${channel} notification (${expectedStatus})`, Boolean(notified) && notified.length === 1 && notified[0].status === expectedStatus,
      notified ? `entries=${notified.length} status=${notified[0].status}` : 'no notification within 120 s');

    // ---- 3. escalation ----
    await control('/__alert', { alert_id: 'REHEARSAL-ALERT-1', severity: 'CRITICAL' });
    const escalated = await waitFor(async () => {
      await api('GET', '/api/alerts?pageSize=5');
      const log = await api('GET', `/api/notifications/log?alertId=REHEARSAL-ALERT-1&channel=${channel}&pageSize=20`);
      const items = log.json?.data?.items ?? [];
      return items.some((e) => String(e.summary).includes('[ESCALATED]')) ? items : null;
    }, { timeoutMs: 180_000, everyMs: 6_000 });
    check('severity raised upstream (HIGH -> CRITICAL) -> one [ESCALATED] follow-up', Boolean(escalated) && escalated.length === 2,
      escalated ? `entries=${escalated.length}` : 'no escalation within 180 s');
    await sleep(70_000); // let at least one more poll/sync pass: no further notification may appear
    const after = (await api('GET', `/api/notifications/log?alertId=REHEARSAL-ALERT-1&channel=${channel}&pageSize=20`)).json?.data?.items ?? [];
    check('later polls send nothing more (no duplicates)', after.length === 2, `entries=${after.length}`);

    // ---- 4. upstream outage and recovery ----
    await control('/__fail', { on: true });
    await sleep(65_000); // adapter cache is 1 minute: after it, the next call hits the failing upstream
    const degradedAlerts = await api('GET', '/api/alerts?pageSize=50');
    check('upstream outage: alerts still load from stale cache (no 500)', degradedAlerts.status === 200, `status=${degradedAlerts.status}`);
    const degradedChat = await api('POST', '/api/chat', { question: 'Is anything wrong?', service: 'main' });
    check('upstream outage: chat answers an honest 503, never a made-up answer', degradedChat.status === 503 && !degradedChat.text.includes('FAKE answer'), `status=${degradedChat.status}`);
    await control('/__fail', { on: false });
    const recovered = await api('POST', '/api/chat', { question: 'Is it back?', service: 'main' });
    check('upstream recovery: chat works again', recovered.status === 200 && recovered.text.includes('FAKE answer'), `status=${recovered.status}`);

    const st = await (await fetch(`${FAKE}/__state`)).json();
    console.log(`upstream calls: logs=${st.requests.logs} alerts=${st.requests.alerts} chat=${st.requests.chat}`);
  } finally {
    stop();
  }
}

main()
  .catch((e) => { check('rehearsal ran to completion', false, e.message); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
    process.exit(failed.length ? 1 : 0);
  });
