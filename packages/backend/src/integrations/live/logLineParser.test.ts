import { describe, it, expect } from 'vitest';
import { parseLogLine, dedupeByNaturalKey, stableSortDesc } from './logLineParser';

const CTX = { service: 'main', environment: 'qa', fallbackMs: Date.parse('2026-10-08T09:00:00.000Z') };

describe('logLineParser', () => {
  it('parses a JSON-stringified log entry: real timestamp, embedded level, verbatim message', () => {
    const raw = JSON.stringify({
      timestamp: '2026-10-08T09:26:10.209Z',
      level: 'error',
      message: '[wallet:getPendingReward] X-Internal-Auth-Urbani no está configurado',
    });
    const { entry, sortKeyMs } = parseLogLine(raw, CTX);
    expect(entry.message).toBe('[wallet:getPendingReward] X-Internal-Auth-Urbani no está configurado');
    expect(entry.level).toBe('ERROR'); // normalized from "error"
    expect(entry.timestamp).toBe('2026-10-08T09:26:10.209Z');
    expect(entry.service).toBe('main');
    expect(entry.environment).toBe('qa');
    expect(entry.id).toBeTruthy();
    expect(sortKeyMs).toBe(Date.parse('2026-10-08T09:26:10.209Z'));
  });

  it('parses a plain-string evidence line: infers level, falls back to the alert timestamp', () => {
    const { entry, sortKeyMs } = parseLogLine(
      'Error user balances  ApiError: No se pudo completar la operación en Wallet',
      CTX,
    );
    expect(entry.message).toBe('Error user balances  ApiError: No se pudo completar la operación en Wallet');
    expect(entry.level).toBe('ERROR'); // "Error" inferred
    // No timestamp in the line -> fallback (alert timestamp) is used.
    expect(entry.timestamp).toBe('2026-10-08T09:00:00.000Z');
    expect(sortKeyMs).toBe(CTX.fallbackMs);
  });

  it('preserves Spanish text verbatim and does not translate', () => {
    const msg = 'No se pudo completar la operación en Wallet';
    const { entry } = parseLogLine(msg, CTX);
    expect(entry.message).toBe(msg);
  });

  it('infers WARN / INFO when no explicit level is present', () => {
    expect(parseLogLine('high latency WARNING on /orders', CTX).entry.level).toBe('WARN');
    expect(parseLogLine('GET /health 200 ok', CTX).entry.level).toBe('INFO');
  });

  it('produces a deterministic id and dedupes identical lines on the natural key', () => {
    const a = parseLogLine('same line', CTX);
    const b = parseLogLine('same line', CTX);
    expect(a.entry.id).toBe(b.entry.id);
    expect(dedupeByNaturalKey([a, b])).toHaveLength(1);
  });

  it('sorts newest-first; an unparseable timestamp with no fallback sorts last', () => {
    const noFallback = { service: 'main', environment: 'qa', fallbackMs: undefined };
    const tuples = [
      parseLogLine({ timestamp: 'not-a-date', message: 'unparseable' }, noFallback),
      parseLogLine({ timestamp: '2026-10-08T04:00:00Z', message: 'newer' }, noFallback),
      parseLogLine({ timestamp: '2026-10-08T03:00:00Z', message: 'older' }, noFallback),
    ];
    const sorted = stableSortDesc(tuples).map((t) => t.entry.message);
    expect(sorted).toEqual(['newer', 'older', 'unparseable']);
  });
});
