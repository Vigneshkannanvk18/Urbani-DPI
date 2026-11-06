import type { HealthRange, HealthSeriesPoint, ProbeStatus, UptimeWindow } from '@urbani/shared';

/**
 * Uptime math (DPI 2 item 9). Uptime % = UP samples / all samples in the window (strict: DEGRADED and DOWN both
 * count against it). With fewer than `minSamples` samples the result is "insufficient data" (null), never a fake 100%.
 */
export const RANGE_MS: Record<HealthRange, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

export function computeUptime(results: ReadonlyArray<{ status: ProbeStatus }>, minSamples: number): UptimeWindow {
  const samples = results.length;
  if (samples < minSamples) return { uptimePct: null, samples, insufficientData: true };
  const up = results.filter((r) => r.status === 'UP').length;
  return { uptimePct: Math.round((up / samples) * 10_000) / 100, samples, insufficientData: false };
}

const SEVERITY_ORDER: Record<ProbeStatus, number> = { UP: 0, DEGRADED: 1, DOWN: 2 };

/** Reduces a series to at most `max` points: each group keeps its worst status, mean latency and last timestamp. */
export function downsample(points: HealthSeriesPoint[], max: number): HealthSeriesPoint[] {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / max);
  const out: HealthSeriesPoint[] = [];
  for (let i = 0; i < points.length; i += size) {
    const group = points.slice(i, i + size);
    let worst: ProbeStatus = 'UP';
    for (const p of group) if (SEVERITY_ORDER[p.status] > SEVERITY_ORDER[worst]) worst = p.status;
    const lat = group.map((p) => p.latencyMs).filter((v): v is number => v !== null);
    out.push({
      timestamp: group[group.length - 1].timestamp,
      status: worst,
      latencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    });
  }
  return out;
}
