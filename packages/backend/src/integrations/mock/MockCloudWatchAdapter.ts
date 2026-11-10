import type {
  CloudWatchAdapter,
  CloudWatchLogQuery,
  CloudWatchMetricQuery,
  WithMeta,
} from '../types';
import type { LogEntry, MetricSnapshot } from '@urbani/shared';
import { mockLogs, mockMetrics, MOCK_NOTE } from './mockData';
import { filterLogEntries, sortLogEntries } from '../logFilter';
import { SyntheticLogSet, SYNTHETIC_DEFAULT_SEED } from './syntheticLogs';

/** Largest window a single synthetic search may return (the export cap is the real ceiling above this). */
export const SYNTHETIC_MAX_WINDOW = 100_000;

/**
 * MockCloudWatchAdapter (Phase 1). Returns seeded telemetry with a MOCK label.
 * Replaced by AWSCloudWatchAdapter in Phase 2 without any change above this line.
 *
 * With `syntheticVolume` > 0 (MOCK_LOG_VOLUME, test/dev only; guarded in config) it serves that many
 * deterministic generated lines instead (still source MOCK, scope says synthetic) and honours the caller's
 * `limit` up to SYNTHETIC_MAX_WINDOW instead of the 100-line cap.
 */
export class MockCloudWatchAdapter implements CloudWatchAdapter {
  readonly kind = 'CLOUDWATCH' as const;
  private synthetic: SyntheticLogSet | null = null;

  constructor(private readonly syntheticVolume = 0, private readonly syntheticSeed = SYNTHETIC_DEFAULT_SEED) {}

  async getLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>> {
    if (this.syntheticVolume > 0) return this.getSyntheticLogs(query);
    const matched = sortLogEntries(filterLogEntries(mockLogs, query), query.sort);
    // Honour the documented 100-line cap.
    const limit = Math.min(query.limit ?? 100, 100);
    return {
      meta: {
        source: 'MOCK',
        note: MOCK_NOTE,
        truncated: matched.length > limit,
        windowCap: 100,
        scope: 'Seeded demo log lines (mock data, not real telemetry).',
      },
      value: matched.slice(0, limit),
    };
  }

  private async getSyntheticLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>> {
    this.synthetic ??= new SyntheticLogSet(this.syntheticVolume, this.syntheticSeed);
    const limit = Math.max(1, Math.min(query.limit ?? 100, SYNTHETIC_MAX_WINDOW));
    const res = await this.synthetic.search(query, limit);
    const scope =
      `SYNTHETIC generated log lines (MOCK_LOG_VOLUME=${this.syntheticVolume}, deterministic seed ${this.syntheticSeed}); not real telemetry.` +
      (res.regexBudgetStopped ? ' The regex scan stopped at its time budget; results are partial.' : '');
    return {
      meta: {
        source: 'MOCK',
        note: `${MOCK_NOTE} Synthetic load-test volume: ${this.syntheticVolume} generated lines.`,
        truncated: res.truncated,
        windowCap: limit,
        scope,
      },
      value: res.rows,
    };
  }

  async getMetrics(query: CloudWatchMetricQuery): Promise<WithMeta<MetricSnapshot[]>> {
    let items = [...mockMetrics];
    if (query.service) items = items.filter((m) => m.service === query.service);
    if (query.environment) items = items.filter((m) => m.environment === query.environment);
    if (query.limit) items = items.slice(0, query.limit);
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: items };
  }
}
