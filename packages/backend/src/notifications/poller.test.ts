import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPoller } from './poller';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('notification poller', () => {
  it('runs sync then engine immediately and on every interval, and stops cleanly', async () => {
    const order: string[] = [];
    const stop = startPoller({
      sync: async () => void order.push('sync'),
      run: async () => void order.push('run'),
      intervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['sync', 'run']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(order).toEqual(['sync', 'run', 'sync', 'run']);
    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(order).toHaveLength(4);
  });

  it('never overlaps ticks while one is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = vi.fn(() => gate);
    const run = vi.fn(async () => undefined);
    const stop = startPoller({ sync, run, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sync).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(2);
    stop();
  });

  it('survives a failing tick', async () => {
    const sync = vi.fn().mockRejectedValueOnce(new Error('upstream down')).mockResolvedValue(undefined);
    const stop = startPoller({ sync, run: async () => undefined, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(sync).toHaveBeenCalledTimes(3);
    stop();
  });
});
