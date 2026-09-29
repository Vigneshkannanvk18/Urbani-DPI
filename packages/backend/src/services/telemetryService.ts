import type { Sourced, Paginated, LogEntry, MetricSnapshot, ServiceSummary } from '@urbani/shared';
import { getIntegrations } from '../integrations';
import {
  serviceRepository,
  metricRepository,
  type LogFilter,
} from '../repositories/telemetryRepository';
import { NotFoundError } from '../lib/errors';
import { MOCK_NOTE } from '../integrations/mock/mockData';

/**
 * Telemetry service (Epics 6, 7, 9). Reads logs/metrics/services.
 *
 * Phase 1 serves persisted seed data. The CloudWatch/Urbani adapters are wired
 * here too so Phase 2 can flip the source without changing the API surface:
 * the service decides mock-vs-live, the route never touches an SDK.
 */
export const telemetryService = {
  /**
   * Logs are served through the CloudWatch adapter boundary so the source can be
   * LIVE (real Urbani API) or MOCK without changing this method, the route, or
   * the dashboard. The API contract (paginated, filterable, provenance-labelled)
   * is preserved. Filtering/pagination are applied in-service over the adapter's
   * current window (the API returns the latest window, capped at 100 lines).
   */
  async logs(filter: LogFilter): Promise<Sourced<Paginated<LogEntry>>> {
    const { cloudwatch } = getIntegrations();
    const res = await cloudwatch.getLogs({
      service: filter.service,
      environment: filter.environment,
      level: filter.level,
      search: filter.search,
      limit: 100,
    });

    const all = res.value;
    const page = Math.max(filter.page ?? 1, 1);
    const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 200);
    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize);

    return {
      source: res.meta.source,
      sourceNote: res.meta.note,
      data: { items, page, pageSize, total: all.length },
    };
  },

  metrics(filter: { service?: string; environment?: string }): Sourced<MetricSnapshot[]> {
    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: metricRepository.query({ ...filter, limit: 300 }),
    };
  },

  services(): Sourced<ServiceSummary[]> {
    return { source: 'MOCK', sourceNote: MOCK_NOTE, data: serviceRepository.all() };
  },

  service(id: string): Sourced<ServiceSummary> {
    const svc = serviceRepository.findById(id);
    if (!svc) throw new NotFoundError(`Service not found: ${id}`);
    return { source: 'MOCK', sourceNote: MOCK_NOTE, data: svc };
  },

  /**
   * Demonstrates the adapter boundary end-to-end without changing behaviour:
   * this could be swapped to the live CloudWatch adapter in Phase 2.
   */
  async liveLogsPreview(): Promise<Sourced<LogEntry[]>> {
    const { cloudwatch } = getIntegrations();
    const res = await cloudwatch.getLogs({ limit: 100 });
    return { source: res.meta.source, sourceNote: res.meta.note, data: res.value };
  },
};
