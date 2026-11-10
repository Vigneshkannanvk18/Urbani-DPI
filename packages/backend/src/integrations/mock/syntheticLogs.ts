import type { LogEntry } from '@urbani/shared';
import { assertSafeRegex, regexMatchAll } from '../../lib/safeRegex';
import { effectiveLevels, effectiveServices } from '../logFilter';
import type { CloudWatchLogQuery } from '../types';

/**
 * Synthetic log volume for load / performance testing (DPI 2 item 13). Everything here is FABRICATED and is
 * always surfaced as source MOCK with a scope note saying so. Deterministic (seeded RNG): same (count, seed)
 * gives the same lines. Generated once, cached, newest first, with columnar side arrays so a search over
 * 200,000 lines does not parse a date or lower-case a string per request.
 */

export const SYNTHETIC_ANCHOR_MS = Date.parse('2026-09-23T08:00:00.000Z');
export const SYNTHETIC_DEFAULT_SEED = 1337;
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
/** cumulative % thresholds for DEBUG, INFO, WARN, ERROR, FATAL */
const LEVEL_CUM = [15, 75, 90, 99, 100];
const SERVICES = ['main', 'payments'] as const;
const ENVIRONMENT = 'qa';

/** Per-batch regex work (one vm run each, 250 ms budget per batch) and the total budget for one search. */
const REGEX_BATCH = 4000;
export const SYNTHETIC_REGEX_TOTAL_BUDGET_MS = 1500;
const REGEX_YIELD_MS = 40;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROUTES = ['/orders', '/orders/{id}', '/payments/authorize', '/payments/refund', '/users/me', '/catalogo/productos', '/health', '/carrito'];
const TEMPLATES: Record<(typeof LEVELS)[number], Array<(r: () => number, n: number) => string>> = {
  DEBUG: [
    (r) => `Cache hit for key services:list (ttl=${Math.floor(r() * 300)}s)`,
    (r) => `Cache miss para la clave sesion:${Math.floor(r() * 99999)}, consultando la base de datos`,
    (r) => `Pool stats active=${Math.floor(r() * 20)} idle=${Math.floor(r() * 20)} waiting=${Math.floor(r() * 5)}`,
  ],
  INFO: [
    (r) => `GET ${ROUTES[Math.floor(r() * ROUTES.length)]} 200 ${Math.floor(r() * 400) + 2}ms`,
    (r) => `POST ${ROUTES[Math.floor(r() * ROUTES.length)]} 201 ${Math.floor(r() * 900) + 10}ms`,
    (r) => `Pedido ${Math.floor(r() * 900000) + 100000} creado correctamente para el usuario ${Math.floor(r() * 5000)}`,
    (r) => `Pago aprobado: referencia PAY-${Math.floor(r() * 9999999)} monto=${(r() * 500000 + 1000).toFixed(2)} COP`,
    (r) => `{"event":"order.created","orderId":"ORD-${Math.floor(r() * 9999999)}","items":${Math.floor(r() * 9) + 1},"total":${(r() * 300 + 5).toFixed(2)},"currency":"USD"}`,
    (r) => `{"event":"payment.authorized","ref":"PAY-${Math.floor(r() * 9999999)}","latencyMs":${Math.floor(r() * 800)},"provider":"mock-gateway"}`,
    (r) => `Sesión iniciada para usuario ${Math.floor(r() * 5000)} desde 10.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`,
  ],
  WARN: [
    (r) => `Latency above p95 threshold for ${ROUTES[Math.floor(r() * ROUTES.length)]} (${Math.floor(r() * 2000) + 800}ms)`,
    (r) => `HikariPool-1: Connection is not available, request timed out after ${Math.floor(r() * 20000) + 5000}ms`,
    (r) => `Reintento ${Math.floor(r() * 3) + 1} de 3 al llamar al proveedor de pagos (timeout)`,
    (r) => `{"event":"rate.limit.near","client":"cli-${Math.floor(r() * 500)}","remaining":${Math.floor(r() * 10)}}`,
  ],
  ERROR: [
    (r) => `ConnectionPool: Timeout acquiring connection from pool (waited ${Math.floor(r() * 30000) + 1000}ms)`,
    (r) => `OrdersController: NullReferenceException in order mapping (orderId=${Math.floor(r() * 999999)})`,
    (r) => `Error al procesar el pago ${Math.floor(r() * 9999999)}: tiempo de espera agotado en la pasarela`,
    (r) => `{"event":"error","code":"E${Math.floor(r() * 900) + 100}","message":"upstream unavailable","retryable":${r() > 0.5}}`,
  ],
  FATAL: [
    (r) => `Out of memory: heap exhausted at ${Math.floor(r() * 400) + 600}MB, shutting down worker ${Math.floor(r() * 8)}`,
    () => 'Fatal: no se pudo establecer conexión con la base de datos, el servicio se detiene',
  ],
};

/** ~1% of ERROR/FATAL lines carry a long stack trace (> 1500 chars) so long-line handling is exercised. */
function stackTrace(r: () => number): string {
  const frames: string[] = [];
  const n = 25 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) frames.push(`  at com.urbani.service.Handler${Math.floor(r() * 40)}.process(Handler.java:${Math.floor(r() * 900) + 10})`);
  return `Unhandled exception: java.lang.IllegalStateException: connection closed\n${frames.join('\n')}`;
}

export interface SyntheticSearchResult {
  rows: LogEntry[];
  /** More matching lines existed than `limit`, or the regex time budget stopped the scan. */
  truncated: boolean;
  regexBudgetStopped: boolean;
}

export class SyntheticLogSet {
  readonly entries: LogEntry[];
  private readonly times: Float64Array;
  private readonly levelIdx: Uint8Array;
  private readonly svcIdx: Uint8Array;
  private lower: string[] | null = null;

  constructor(readonly count: number, readonly seed = SYNTHETIC_DEFAULT_SEED) {
    const r = mulberry32(seed);
    this.entries = new Array<LogEntry>(count);
    this.times = new Float64Array(count);
    this.levelIdx = new Uint8Array(count);
    this.svcIdx = new Uint8Array(count);
    const pad = 7;
    for (let i = 0; i < count; i++) {
      const roll = r() * 100;
      let li = 0;
      while (li < LEVEL_CUM.length - 1 && roll >= LEVEL_CUM[li]) li++;
      const level = LEVELS[li];
      const tpls = TEMPLATES[level];
      let message = tpls[Math.floor(r() * tpls.length)](r, i);
      if ((level === 'ERROR' || level === 'FATAL') && r() < 0.05) message += `\n${stackTrace(r)}`;
      const si = r() < 0.6 ? 0 : 1;
      // Strictly decreasing timestamps (about one line per second, newest first).
      const t = SYNTHETIC_ANCHOR_MS - i * 1000 - Math.floor(r() * 900);
      this.times[i] = t;
      this.levelIdx[i] = li;
      this.svcIdx[i] = si;
      this.entries[i] = {
        id: `syn-${String(i + 1).padStart(pad, '0')}`,
        timestamp: new Date(t).toISOString(),
        level,
        service: SERVICES[si],
        environment: ENVIRONMENT,
        message,
      };
    }
  }

  /**
   * Filter in the same semantics as filterLogEntries + sortLogEntries + slice(limit): the first `limit`
   * matches in sort order. Scans only as far as needed. Async so a regex scan yields between batches.
   */
  async search(q: CloudWatchLogQuery, limit: number): Promise<SyntheticSearchResult> {
    const n = this.count;
    const empty = { rows: [], truncated: false, regexBudgetStopped: false };
    if (q.environment && q.environment !== ENVIRONMENT) return empty;
    const services = effectiveServices(q);
    const levels = effectiveLevels(q);
    const svcOk = SERVICES.map((s) => services.length === 0 || services.includes(s));
    const lvlOk = LEVELS.map((l) => levels.length === 0 || levels.includes(l));
    const fromMs = q.startTime ? Date.parse(q.startTime) : NaN;
    const toMs = q.endTime ? Date.parse(q.endTime) : NaN;
    const newestFirst = (q.sort ?? 'newest') !== 'oldest';

    // times are descending, so the [from, to] window is a contiguous index range [lo, hi).
    let lo = 0;
    let hi = n;
    if (!Number.isNaN(toMs)) lo = this.firstIndexWhere((t) => t <= toMs);
    if (!Number.isNaN(fromMs)) hi = this.firstIndexWhere((t) => t < fromMs);

    const needle = q.search && !q.regex ? q.search.toLowerCase() : null;
    if (needle && !this.lower) this.lower = this.entries.map((e) => e.message.toLowerCase());
    const lower = this.lower;
    const regexPattern = q.search && q.regex ? q.search : null;
    if (regexPattern) assertSafeRegex(regexPattern, q.regexMaxLength);

    const rows: LogEntry[] = [];
    let truncated = false;
    let budgetStopped = false;
    const step = newestFirst ? 1 : -1;
    const start = newestFirst ? lo : hi - 1;
    const stop = newestFirst ? hi : lo - 1;
    const basic = (i: number): boolean =>
      svcOk[this.svcIdx[i]] && lvlOk[this.levelIdx[i]] && (needle === null || lower![i].includes(needle));

    if (!regexPattern) {
      for (let i = start; i !== stop; i += step) {
        if (!basic(i)) continue;
        if (rows.length === limit) { truncated = true; break; }
        rows.push(this.entries[i]);
      }
      return { rows, truncated, regexBudgetStopped: false };
    }

    const deadline = Date.now() + SYNTHETIC_REGEX_TOTAL_BUDGET_MS;
    let lastYield = Date.now();
    let i = start;
    outer: while (i !== stop) {
      const idx: number[] = [];
      while (i !== stop && idx.length < REGEX_BATCH) {
        if (basic(i)) idx.push(i);
        i += step;
      }
      if (idx.length === 0) continue;
      const hits = regexMatchAll(regexPattern, idx.map((k) => this.entries[k].message));
      for (let j = 0; j < idx.length; j++) {
        if (!hits[j]) continue;
        if (rows.length === limit) { truncated = true; break outer; }
        rows.push(this.entries[idx[j]]);
      }
      const now = Date.now();
      if (i !== stop && now > deadline) { truncated = true; budgetStopped = true; break; }
      // Let other requests run, but only after ~REGEX_YIELD_MS of work: yielding after every batch made a regex
      // request wait one full queue round trip per batch under load (p95 ~1.8 s at saturation, measured).
      if (now - lastYield >= REGEX_YIELD_MS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        lastYield = Date.now();
      }
    }
    return { rows, truncated, regexBudgetStopped: budgetStopped };
  }

  /** Smallest index whose time satisfies pred (times descend, so pred is monotone false->true). */
  private firstIndexWhere(pred: (t: number) => boolean): number {
    let a = 0;
    let b = this.count;
    while (a < b) {
      const m = (a + b) >> 1;
      if (pred(this.times[m])) b = m;
      else a = m + 1;
    }
    return a;
  }
}
