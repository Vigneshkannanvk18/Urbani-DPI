import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import type { ProbeStatus } from '@urbani/shared';
import { SsrfBlockedError, assertLiteralHostAllowed, guardedLookup, parseTargetUrl, redactText } from './ssrf';

/**
 * One guarded HTTP probe (DPI 2 item 9). Follows at most MAX_REDIRECTS redirects, re-checking every hop against the
 * SSRF guard; reads at most maxResponseBytes of the body; never returns a raw error message (only short, redacted
 * reasons) and never exposes the URL.
 */
export interface HttpProbeRequest {
  url: string;
  method: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Explicit list of acceptable status codes; null = any 2xx or 3xx (200..399). */
  expectedStatus: number[] | null;
  timeoutMs: number;
  degradedAboveMs: number;
}
export interface ProbePolicy {
  allowPrivate: boolean;
  maxResponseBytes: number;
  signal?: AbortSignal;
}
export interface ProbeOutcome {
  status: ProbeStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
}

export const MAX_REDIRECTS = 3;

export function isExpectedStatus(httpStatus: number, expected: number[] | null): boolean {
  return expected ? expected.includes(httpStatus) : httpStatus >= 200 && httpStatus <= 399;
}

/** UP / DEGRADED (slow, or reachable but not an expected status) for a received response. */
export function classifyResponse(httpStatus: number, latencyMs: number, req: Pick<HttpProbeRequest, 'expectedStatus' | 'degradedAboveMs'>): ProbeOutcome {
  if (!isExpectedStatus(httpStatus, req.expectedStatus)) {
    return { status: 'DEGRADED', httpStatus, latencyMs, error: `unexpected status ${httpStatus}` };
  }
  if (latencyMs > req.degradedAboveMs) {
    return { status: 'DEGRADED', httpStatus, latencyMs, error: `slow response (${latencyMs} ms)` };
  }
  return { status: 'UP', httpStatus, latencyMs, error: null };
}

/** Maps a transport error to a short, safe reason. */
export function describeError(err: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `timeout after ${timeoutMs} ms`;
  if (err instanceof SsrfBlockedError) return err.reason;
  const e = err as { code?: unknown; name?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection reset';
  if (code === 'ETIMEDOUT') return 'connection timed out';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host unreachable';
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.includes('SELF_SIGNED') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
    return 'TLS error';
  }
  if (e?.name === 'AbortError') return 'probe aborted';
  return code ? redactText(`request failed (${code})`) : 'request failed';
}

interface HopResult {
  statusCode: number;
  location: string | null;
  /** performance.now() when the response headers arrived (latency = time to first response, not body download). */
  headersAt: number;
}

function requestOnce(url: URL, req: HttpProbeRequest, policy: ProbePolicy, signal: AbortSignal): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    try {
      assertLiteralHostAllowed(url, policy.allowPrivate);
    } catch (err) {
      return reject(err);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const clientReq = mod.request(
      url,
      {
        method: req.method,
        headers: { 'user-agent': 'urbani-radar-health-probe', accept: '*/*', ...(req.headers ?? {}) },
        lookup: guardedLookup(policy.allowPrivate) as never,
        signal,
        agent: false,
      },
      (res) => {
        const headersAt = performance.now();
        const statusCode = res.statusCode ?? 0;
        const loc = res.headers.location;
        let read = 0;
        res.on('data', (chunk: Buffer) => {
          read += chunk.length;
          if (read >= policy.maxResponseBytes) res.destroy(); // cap the read; the status is already known
        });
        res.on('error', () => undefined);
        res.on('close', () => resolve({ statusCode, location: typeof loc === 'string' ? loc : null, headersAt }));
        res.on('end', () => resolve({ statusCode, location: typeof loc === 'string' ? loc : null, headersAt }));
      },
    );
    clientReq.on('error', reject);
    clientReq.end();
  });
}

/** Never throws: every failure becomes a DOWN outcome with a short redacted reason. */
export async function httpProbe(req: HttpProbeRequest, policy: ProbePolicy): Promise<ProbeOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  const onExternalAbort = () => controller.abort();
  policy.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const started = performance.now();
  try {
    const first = parseTargetUrl(req.url);
    if (!first.ok) return { status: 'DOWN', httpStatus: null, latencyMs: null, error: first.reason };
    let url = first.url;
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(url, req, policy, controller.signal);
      const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode) && res.location;
      if (isRedirect) {
        if (hop >= MAX_REDIRECTS) {
          return { status: 'DOWN', httpStatus: res.statusCode, latencyMs: Math.round(res.headersAt - started), error: 'too many redirects' };
        }
        let next: URL;
        try {
          next = new URL(res.location as string, url);
        } catch {
          return { status: 'DOWN', httpStatus: res.statusCode, latencyMs: null, error: 'invalid redirect target' };
        }
        const check = parseTargetUrl(next.toString());
        if (!check.ok) return { status: 'DOWN', httpStatus: res.statusCode, latencyMs: null, error: `redirect refused: ${check.reason}` };
        url = check.url;
        continue;
      }
      return classifyResponse(res.statusCode, Math.round(res.headersAt - started), req);
    }
  } catch (err) {
    return { status: 'DOWN', httpStatus: null, latencyMs: null, error: redactText(describeError(err, timedOut, req.timeoutMs)) };
  } finally {
    clearTimeout(timer);
    policy.signal?.removeEventListener('abort', onExternalAbort);
  }
}
