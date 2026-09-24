import type {
  CloudWatchAdapter,
  CloudWatchLogQuery,
  CloudWatchMetricQuery,
  WithMeta,
} from '../types';
import type { LogEntry, MetricSnapshot } from '@urbani/shared';
import { mockLogs, mockMetrics, MOCK_NOTE } from './mockData';

/**
 * MockCloudWatchAdapter (Phase 1). Returns seeded telemetry with a MOCK label.
 * Replaced by AWSCloudWatchAdapter in Phase 2 without any change above this line.
 */
export class MockCloudWatchAdapter implements CloudWatchAdapter {
  readonly kind = 'CLOUDWATCH' as const;

  async getLogs(query: CloudWatchLogQuery): Promise<WithMeta<LogEntry[]>> {
    let items = [...mockLogs];
    if (query.service) items = items.filter((l) => l.service === query.service);
    if (query.environment) items = items.filter((l) => l.environment === query.environment);
    if (query.level) items = items.filter((l) => l.level === query.level);
    if (query.search) {
      const q = query.search.toLowerCase();
      items = items.filter((l) => l.message.toLowerCase().includes(q));
    }
    // Honour the documented 100-line cap.
    const limit = Math.min(query.limit ?? 100, 100);
    items = items.slice(0, limit);
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: items };
  }

  async getMetrics(query: CloudWatchMetricQuery): Promise<WithMeta<MetricSnapshot[]>> {
    let items = [...mockMetrics];
    if (query.service) items = items.filter((m) => m.service === query.service);
    if (query.environment) items = items.filter((m) => m.environment === query.environment);
    if (query.limit) items = items.slice(0, query.limit);
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: items };
  }
}
