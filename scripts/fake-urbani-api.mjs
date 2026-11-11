#!/usr/bin/env node
/**
 * Fake Urbani QA telemetry API (dev/test only). Mimics the endpoints the live adapters call, so INTEGRATION_MODE=live can be
 * rehearsed locally with NO access to Urbani or AWS:
 *   GET  /logs/latest?service=      GET /logs/history?service=&limit=
 *   GET  /alerts/latest?service=    GET /alerts/history?service=&limit=
 *   POST /chat   {service, question}
 * All data endpoints require the x-api-key header. Control endpoints (no key, for the rehearsal driver) change what the
 * "upstream" returns:
 *   POST /__alert  {service, alert_id, severity?, anomaly_type?, summary?, ...}   create or change an alert (same id = update)
 *   POST /__fail   {on: true|false}                                               make every data endpoint answer 500
 *   GET  /__state                                                                 current alerts, request counters
 * Run standalone:  node scripts/fake-urbani-api.mjs [--port 4300] [--key fake-key]
 * Everything it returns is synthetic. It must never be pointed at by a production deployment.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export function createFakeUrbani({ key = 'fake-urbani-key' } = {}) {
  const state = { fail: false, requests: { logs: 0, alerts: 0, chat: 0 }, alerts: new Map(), questions: [] };
  const nowIso = (minAgo = 0) => new Date(Date.now() - minAgo * 60_000).toISOString();

  function logLines(service) {
    return [
      { timestamp: nowIso(4), message: JSON.stringify({ timestamp: nowIso(4), level: 'INFO', message: `${service}: request completed in 82 ms` }) },
      { timestamp: nowIso(3), message: JSON.stringify({ timestamp: nowIso(3), level: 'WARN', message: `${service}: connection pool at 85% capacity` }) },
      { timestamp: nowIso(2), message: JSON.stringify({ timestamp: nowIso(2), level: 'ERROR', message: `${service}: upstream timeout after 30000 ms (FAKE-LINE)` }) },
    ];
  }
  function alertBody(a) {
    return {
      service_id: a.service, timestamp: a.timestamp, alert_id: a.alert_id, anomaly_type: a.anomaly_type, severity: a.severity,
      summary: a.summary, probable_cause: a.probable_cause, recommendation: a.recommendation,
      evidence: [JSON.stringify({ timestamp: a.timestamp, level: 'ERROR', message: `${a.service}: ${a.anomaly_type} evidence line (FAKE)` })],
    };
  }
  const latestFor = (service) => [...state.alerts.values()].filter((a) => a.service === service).sort((x, y) => y.updated - x.updated)[0];

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const service = url.searchParams.get('service') ?? 'main';
    // ---- control plane (no api key) ----
    if (url.pathname === '/__state') return send(res, 200, { fail: state.fail, requests: state.requests, alerts: [...state.alerts.values()], questions: state.questions });
    if (url.pathname === '/__fail' && req.method === 'POST') { state.fail = Boolean((await readBody(req)).on); return send(res, 200, { fail: state.fail }); }
    if (url.pathname === '/__alert' && req.method === 'POST') {
      const b = await readBody(req);
      const prev = state.alerts.get(b.alert_id);
      const a = {
        service: 'main', timestamp: prev?.timestamp ?? nowIso(1), anomaly_type: 'ElevatedErrorRate', severity: 'HIGH',
        summary: 'Error rate is above baseline', probable_cause: 'Upstream dependency is slow', recommendation: 'Check the upstream dependency health',
        ...prev, ...b, updated: Date.now(),
      };
      state.alerts.set(a.alert_id, a);
      return send(res, 200, { ok: true, alert: a });
    }
    // ---- data plane (api key required) ----
    if (req.headers['x-api-key'] !== key) return send(res, 403, { message: 'Forbidden' });
    if (state.fail) return send(res, 500, { message: 'Internal server error (simulated outage)' });
    if (url.pathname === '/logs/latest') {
      state.requests.logs++;
      return send(res, 200, { service_id: service, window_start: nowIso(5), window_end: nowIso(0), log_count: 3, logs: logLines(service) });
    }
    if (url.pathname === '/logs/history') {
      state.requests.logs++;
      return send(res, 200, { service_id: service, count: 1, windows: [{ window_start: nowIso(10), window_end: nowIso(5), log_count: 3, logs: logLines(service) }] });
    }
    if (url.pathname === '/alerts/latest') {
      state.requests.alerts++;
      const a = latestFor(service);
      return send(res, 200, a ? alertBody(a) : {});
    }
    if (url.pathname === '/alerts/history') {
      state.requests.alerts++;
      const list = [...state.alerts.values()].filter((a) => a.service === service).map(alertBody);
      return send(res, 200, { service_id: service, count: list.length, alerts: list });
    }
    if (url.pathname === '/chat' && req.method === 'POST') {
      state.requests.chat++;
      const b = await readBody(req);
      state.questions.push(b.question);
      return send(res, 200, {
        service_id: b.service ?? service, question: b.question,
        answer: `**FAKE answer** for ${b.service ?? service}: the most recent errors are upstream timeouts.`,
        evidence: { log_windows: 2, alerts: state.alerts.size }, model_id: 'fake-model',
      });
    }
    return send(res, 404, { message: 'not found' });
  });
  return { server, state };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const port = Number(arg('port', 4300));
  const { server } = createFakeUrbani({ key: arg('key', 'fake-urbani-key') });
  server.listen(port, '127.0.0.1', () => console.log(`fake Urbani API on http://127.0.0.1:${port} (x-api-key: ${arg('key', 'fake-urbani-key')})`));
}
