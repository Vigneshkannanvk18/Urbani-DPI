import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyAddress, addressBlockReason, parseTargetUrl, redactText, safeUrlLabel } from './ssrf';
import { classifyResponse, httpProbe } from './httpProbe';
import { loadTargets, WAITING_NOTE } from './targets';
import { computeUptime, downsample } from './uptime';
import { HealthRunner, startHealthScheduler } from './runner';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';

/** Health probes (DPI 2 item 9): SSRF blocklist, guarded HTTP probe against a local server, targets, uptime math, scheduler. */

describe('SSRF blocklist', () => {
  it.each([
    ['169.254.169.254', 'blocked'],
    ['169.254.0.1', 'blocked'],
    ['fe80::1', 'blocked'],
    ['fd00:ec2::254', 'blocked'],
    ['::ffff:169.254.169.254', 'blocked'],
    ['::ffff:a9fe:a9fe', 'blocked'],
    ['0.0.0.0', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['100.100.100.200', 'blocked'],
    ['127.0.0.1', 'private'],
    ['::1', 'private'],
    ['::ffff:127.0.0.1', 'private'],
    ['10.1.2.3', 'private'],
    ['172.16.0.9', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['fd12:3456::1', 'private'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['not-an-ip', 'blocked'],
  ])('classifies %s as %s', (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it('metadata ranges are blocked even when private targets are allowed; private ranges follow the flag', () => {
    expect(addressBlockReason('169.254.169.254', true)).toMatch(/blocked/);
    expect(addressBlockReason('fd00:ec2::254', true)).toMatch(/blocked/);
    expect(addressBlockReason('10.0.0.5', true)).toBeNull();
    expect(addressBlockReason('10.0.0.5', false)).toMatch(/HEALTH_ALLOW_PRIVATE_TARGETS/);
    expect(addressBlockReason('8.8.8.8', false)).toBeNull();
  });

  it('only http(s) URLs without credentials are accepted', () => {
    expect(parseTargetUrl('https://example.com/health?x=1').ok).toBe(true);
    expect(parseTargetUrl('ftp://example.com').ok).toBe(false);
    expect(parseTargetUrl('file:///etc/passwd').ok).toBe(false);
    expect(parseTargetUrl('https://user:pw@example.com').ok).toBe(false);
    expect(parseTargetUrl('nonsense').ok).toBe(false);
  });

  it('redaction strips URL paths, queries and credentials from free text', () => {
    const text = redactText('failed https://user:secret@host.example/p?token=abc and http://10.0.0.1:8080/x?k=v');
    expect(text).not.toMatch(/secret|token|abc|k=v|\/p\b/);
    expect(text).toContain('https://host.example');
    expect(safeUrlLabel('https://u:p@host.example:8443/a/b?c=d')).toBe('https://host.example:8443');
  });
});

describe('response classification', () => {
  const base = { expectedStatus: null, degradedAboveMs: 100 };
  it('UP / slow DEGRADED / unexpected-but-reachable DEGRADED', () => {
    expect(classifyResponse(200, 20, base).status).toBe('UP');
    expect(classifyResponse(302, 20, base).status).toBe('UP');
    expect(classifyResponse(200, 500, base)).toMatchObject({ status: 'DEGRADED', error: expect.stringMatching(/slow/) });
    expect(classifyResponse(503, 20, base)).toMatchObject({ status: 'DEGRADED', error: 'unexpected status 503' });
    expect(classifyResponse(404, 20, { ...base, expectedStatus: [404] }).status).toBe('UP');
    expect(classifyResponse(200, 20, { ...base, expectedStatus: [204] }).status).toBe('DEGRADED');
  });
});

describe('guarded HTTP probe against a local server', () => {
  let server: http.Server;
  let base: string;
  const policy = { allowPrivate: true, maxResponseBytes: 4096 };
  const req = (path: string, over: Partial<Parameters<typeof httpProbe>[0]> = {}) => ({
    url: `${base}${path}`, method: 'GET' as const, expectedStatus: null, timeoutMs: 1500, degradedAboveMs: 1000, ...over,
  });

  beforeAll(async () => {
    server = http.createServer((rq, res) => {
      const url = rq.url ?? '/';
      if (url === '/ok') return void res.end('ok');
      if (url === '/slow') return void setTimeout(() => res.end('slow'), 150);
      if (url === '/hang') return; // never answers
      if (url === '/boom') {
        res.statusCode = 503;
        return void res.end('down');
      }
      if (url === '/to-metadata') {
        res.statusCode = 302;
        res.setHeader('Location', 'http://169.254.169.254/latest/meta-data/');
        return void res.end();
      }
      if (url === '/to-ok') {
        res.statusCode = 302;
        res.setHeader('Location', '/ok');
        return void res.end();
      }
      if (url === '/loop') {
        res.statusCode = 302;
        res.setHeader('Location', '/loop');
        return void res.end();
      }
      if (url === '/big') {
        res.write(Buffer.alloc(1_000_000, 97));
        return void res.end(Buffer.alloc(1_000_000, 97));
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('UP for a fast 200', async () => {
    expect(await httpProbe(req('/ok'), policy)).toMatchObject({ status: 'UP', httpStatus: 200, error: null, latencyMs: expect.any(Number) });
  });
  it('DEGRADED when slower than degradedAboveMs', async () => {
    expect(await httpProbe(req('/slow', { degradedAboveMs: 50 }), policy)).toMatchObject({ status: 'DEGRADED', httpStatus: 200 });
  });
  it('DEGRADED for a reachable service answering an unexpected status', async () => {
    expect(await httpProbe(req('/boom'), policy)).toMatchObject({ status: 'DEGRADED', httpStatus: 503, error: 'unexpected status 503' });
  });
  it('DOWN with a short reason when the connection is refused', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const out = await httpProbe({ ...req('/'), url: `http://127.0.0.1:${port}/health?secret=1` }, policy);
    expect(out).toMatchObject({ status: 'DOWN', httpStatus: null, error: 'connection refused' });
    expect(JSON.stringify(out)).not.toMatch(/secret|127\.0\.0\.1/);
  });
  it('DOWN on timeout', async () => {
    const out = await httpProbe(req('/hang', { timeoutMs: 200 }), policy);
    expect(out).toMatchObject({ status: 'DOWN', error: 'timeout after 200 ms' });
  });
  it('refuses a redirect into the metadata range (never contacted)', async () => {
    const out = await httpProbe(req('/to-metadata'), policy);
    expect(out.status).toBe('DOWN');
    expect(out.error).toMatch(/^blocked: link-local/);
  });
  it('follows a redirect to an allowed target and judges the final response', async () => {
    expect(await httpProbe(req('/to-ok'), policy)).toMatchObject({ status: 'UP', httpStatus: 200 });
  });
  it('stops after too many redirects', async () => {
    expect(await httpProbe(req('/loop'), policy)).toMatchObject({ status: 'DOWN', error: 'too many redirects' });
  });
  it('blocks a loopback target unless private targets are allowed', async () => {
    const out = await httpProbe(req('/ok'), { ...policy, allowPrivate: false });
    expect(out.status).toBe('DOWN');
    expect(out.error).toMatch(/HEALTH_ALLOW_PRIVATE_TARGETS/);
  });
  it('blocks a hostname that resolves into a blocked range (guarded lookup)', async () => {
    const out = await httpProbe({ ...req('/ok'), url: `http://localhost:${(server.address() as AddressInfo).port}/ok` }, { ...policy, allowPrivate: false });
    expect(out.status).toBe('DOWN');
    expect(out.error).toMatch(/^blocked/);
  });
  it('rejects non-http schemes and credentials in the URL', async () => {
    expect((await httpProbe({ ...req('/'), url: 'file:///etc/passwd' }, policy)).status).toBe('DOWN');
    expect((await httpProbe({ ...req('/'), url: 'http://u:p@127.0.0.1/' }, policy)).error).toMatch(/credentials/);
  });
  it('caps the response read (a 2 MB body does not stall the probe)', async () => {
    const out = await httpProbe(req('/big'), { ...policy, maxResponseBytes: 1024 });
    expect(out).toMatchObject({ status: 'UP', httpStatus: 200 });
  });
});

describe('targets', () => {
  const builtin = { urbaniApiConfigured: false, urbaniServices: ['main', 'payments'] };

  it('QA / Main / Payment without a URL are placeholders with the exact note and the env var to set', () => {
    const { targets, errors } = loadTargets(null, builtin);
    expect(errors).toEqual([]);
    expect(targets.map((t) => t.id)).toEqual(['radar-api', 'urbani-qa-telemetry-api', 'qa', 'main', 'payment']);
    for (const id of ['qa', 'main', 'payment']) {
      const t = targets.find((x) => x.id === id)!;
      expect(t.kind).toBe('placeholder');
      expect(WAITING_NOTE).toBe('No health endpoint configured -- needs Urbani input');
      expect((t as { configHint: string }).configHint).toContain('HEALTH_TARGETS');
    }
  });

  it('the Urbani API target is labelled as the observability API, not the customer QA app', () => {
    const t = loadTargets(null, builtin).targets.find((x) => x.id === 'urbani-qa-telemetry-api')!;
    expect(t.name).toBe('Urbani QA telemetry API');
    expect(t.description).toMatch(/NOT the health of the customer's QA application/);
  });

  it('a configured entry replaces the placeholder with the same id and maps to a service when it exists', () => {
    const raw = JSON.stringify([
      { id: 'main', type: 'http', url: 'https://main.example.com/health' },
      { id: 'payment', type: 'http', url: 'https://pay.example.com/h', service: 'payments', method: 'HEAD', expectedStatus: [200, 204], timeoutMs: 1000, degradedAboveMs: 300 },
      { id: 'extra', name: 'Extra', type: 'http', url: 'http://10.0.0.5/up' },
    ]);
    const { targets, errors } = loadTargets(raw, builtin);
    expect(errors).toEqual([]);
    expect(targets.map((t) => `${t.id}:${t.kind}`)).toEqual([
      'radar-api:radar', 'urbani-qa-telemetry-api:urbani-api', 'qa:placeholder', 'main:http', 'payment:http', 'extra:http',
    ]);
    expect(targets.find((t) => t.id === 'main')).toMatchObject({ name: 'Main', service: 'main', method: 'GET', timeoutMs: 5000, degradedAboveMs: 2000 });
    expect(targets.find((t) => t.id === 'payment')).toMatchObject({ service: 'payments', method: 'HEAD', expectedStatus: [200, 204] });
    expect(targets.find((t) => t.id === 'extra')).toMatchObject({ service: null });
  });

  it('invalid config is reported (without echoing URLs) and skipped, never fatal', () => {
    expect(loadTargets('{nope', builtin).errors[0]).toMatch(/not valid JSON/);
    expect(loadTargets('{"a":1}', builtin).errors[0]).toMatch(/must be a JSON array/);
    const raw = JSON.stringify([
      { id: 'qa', type: 'http', url: 'ftp://secret-host/x' },
      { id: 'radar-api', type: 'http', url: 'https://a.example.com' },
      { id: 'BAD ID', type: 'http', url: 'https://a.example.com' },
      { id: 'dup', type: 'http', url: 'https://a.example.com' },
      { id: 'dup', type: 'http', url: 'https://b.example.com' },
      { id: 'creds', type: 'http', url: 'https://user:hunter2@a.example.com' },
    ]);
    const { targets, errors } = loadTargets(raw, builtin);
    expect(errors).toHaveLength(5);
    expect(errors.join(' ')).not.toMatch(/secret-host|hunter2/);
    expect(targets.find((t) => t.id === 'qa')!.kind).toBe('placeholder');
    expect(targets.filter((t) => t.id === 'dup')).toHaveLength(1);
  });
});

describe('uptime math', () => {
  const mk = (up: number, degraded: number, down: number) => [
    ...Array(up).fill({ status: 'UP' }), ...Array(degraded).fill({ status: 'DEGRADED' }), ...Array(down).fill({ status: 'DOWN' }),
  ];
  it('is UP samples over all samples, with the sample count', () => {
    expect(computeUptime(mk(8, 1, 1), 10)).toEqual({ uptimePct: 80, samples: 10, insufficientData: false });
    expect(computeUptime(mk(99, 0, 1), 10)).toEqual({ uptimePct: 99, samples: 100, insufficientData: false });
    expect(computeUptime(mk(2, 0, 1), 3)).toEqual({ uptimePct: 66.67, samples: 3, insufficientData: false });
  });
  it('reports insufficient data instead of a fake 100%', () => {
    expect(computeUptime(mk(9, 0, 0), 10)).toEqual({ uptimePct: null, samples: 9, insufficientData: true });
    expect(computeUptime([], 10)).toEqual({ uptimePct: null, samples: 0, insufficientData: true });
  });
  it('downsample keeps the worst status per group and the point count bounded', () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({
      timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
      status: (i === 37 ? 'DOWN' : 'UP') as 'UP' | 'DOWN', latencyMs: i === 37 ? null : 10,
    }));
    const out = downsample(pts, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.filter((p) => p.status === 'DOWN')).toHaveLength(1);
    expect(downsample(pts.slice(0, 5), 10)).toHaveLength(5);
  });
});

describe('runner and scheduler', () => {
  let db: ReturnType<typeof freshTestDb>;
  afterEach(() => {
    vi.useRealTimers();
    db?.close();
  });

  function makeRunner(probe: (r: Parameters<typeof httpProbe>[0]) => Promise<ReturnType<typeof classifyResponse>>, raw: string | null = null, now?: () => Date) {
    db = freshTestDb();
    return new HealthRunner({
      repos: getRepositories,
      load: () => loadTargets(raw, { urbaniApiConfigured: false, urbaniServices: [] }),
      policy: () => ({ allowPrivate: true, maxResponseBytes: 1024 }),
      urbani: () => ({ baseUrl: null, apiKey: null, service: 'main' }),
      probe: async (r) => probe(r),
      now,
    });
  }

  it('probes configured targets and the built-in Radar API; placeholders and an unconfigured Urbani API are never probed or stored', async () => {
    const probe = vi.fn(async () => classifyResponse(200, 12, { expectedStatus: null, degradedAboveMs: 1000 }));
    const runner = makeRunner(probe, JSON.stringify([{ id: 'main', type: 'http', url: 'https://main.example.com/health' }]));
    const results = await runner.runNow();
    expect(results.map((r) => r.targetId).sort()).toEqual(['main', 'radar-api']);
    expect(probe).toHaveBeenCalledTimes(1);
    const repos = getRepositories();
    expect(await repos.health.latestResult('radar-api')).toMatchObject({ status: 'UP', httpStatus: null });
    expect(await repos.health.latestResult('main')).toMatchObject({ status: 'UP', httpStatus: 200 });
    for (const id of ['qa', 'payment', 'urbani-qa-telemetry-api']) expect(await repos.health.latestResult(id)).toBeNull();
  });

  it('redacts errors before storing them', async () => {
    const probe = vi.fn(async () => ({ status: 'DOWN' as const, httpStatus: null, latencyMs: null, error: 'failed https://user:pw@host.example/p?token=abc' }));
    const runner = makeRunner(probe, JSON.stringify([{ id: 'qa', type: 'http', url: 'https://qa.example.com/h' }]));
    await runner.runNow();
    const stored = await getRepositories().health.latestResult('qa');
    expect(stored!.error).toBe('failed https://host.example');
  });

  it('stores one result per target per minute (a second run in the same minute replaces the first)', async () => {
    const t = new Date('2026-10-01T10:00:05.000Z');
    let status = 200;
    const probe = vi.fn(async () => classifyResponse(status, 5, { expectedStatus: null, degradedAboveMs: 1000 }));
    const runner = makeRunner(probe, JSON.stringify([{ id: 'qa', type: 'http', url: 'https://qa.example.com/h' }]), () => t);
    await runner.runNow();
    status = 503;
    await runner.runNow();
    const rows = await getRepositories().health.listResults('qa', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('DEGRADED');
  });

  it('is single-flight: concurrent runNow calls share one run', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const probe = vi.fn(async () => {
      await gate;
      return classifyResponse(200, 1, { expectedStatus: null, degradedAboveMs: 1000 });
    });
    const runner = makeRunner(probe, JSON.stringify([{ id: 'qa', type: 'http', url: 'https://qa.example.com/h' }]));
    const a = runner.runNow();
    const b = runner.runNow();
    expect(runner.running).toBe(true);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);
    expect(runner.running).toBe(false);
    await runner.runNow();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('scheduler: jittered interval, never overlaps a slow run, stops cleanly', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    let calls = 0;
    const runner = {
      stop: vi.fn(),
      runNow: vi.fn(async () => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return [];
      }),
    };
    const stop = startHealthScheduler(runner, { intervalMs: 60_000, initialDelayMs: 1000, random: () => 0.5 });
    expect(runner.runNow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runner.runNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000); // first run is still in flight: no second run starts
    expect(runner.runNow).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000); // random 0.5 => exactly the interval
    expect(runner.runNow).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.runNow).toHaveBeenCalledTimes(3);
    stop();
    expect(runner.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runner.runNow).toHaveBeenCalledTimes(3);
  });

  it('scheduler jitter stays within +/-10% of the interval', async () => {
    vi.useFakeTimers();
    const runner = { stop: vi.fn(), runNow: vi.fn(async () => []) };
    const stop = startHealthScheduler(runner, { intervalMs: 100_000, initialDelayMs: 0, random: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.runNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(runner.runNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.runNow).toHaveBeenCalledTimes(2);
    stop();
  });
});
