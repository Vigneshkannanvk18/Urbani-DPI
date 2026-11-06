import type {
  CloudWatchAdapter,
  CloudWatchLogQuery,
  CloudWatchMetricQuery,
  WithMeta,
} from '../types';
import type { LogEntry, MetricSnapshot } from '@urbani/shared';
import { mockLogs, mockMetrics, MOCK_NOTE } from './mockData';
import { filterLogEntries, sortLogEntries } from '../logFilter';

/**
 * MockCloudWatchAdapter (Phase 1). Returns seeded telemetry with a MOCK label.
 * Replaced by AWSCloudWatchAdapter in Phase 2 without any change above this line.
 */
export class MockCloudWatchAdapter implements CloudWatchAdapter {
  readonly kind = 'CLOUDWATCH' as const;

  async getLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>> {
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

  async getMetrics(query: CloudWatchMetricQuery): Promise<WithMeta<MetricSnapshot[]>> {
    let items = [...mockMetrics];
    if (query.service) items = items.filter((m) => m.service === query.service);
    if (query.environment) items = items.filter((m) => m.environment === query.environment);
    if (query.limit) items = items.slice(0, query.limit);
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: items };
  }
}
