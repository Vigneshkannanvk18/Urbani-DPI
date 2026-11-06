import type { Sourced, Paginated, LogEntry, LogSearchMeta, MetricSnapshot, ServiceSummary } from '@urbani/shared';
import { getIntegrations } from '../integrations';
import { getRepositories } from '../repositories';
import { appliedFilters, type LogSearch } from '../lib/logQuery';
import { NotFoundError } from '../lib/errors';
import { MOCK_NOTE } from '../integrations/mock/mockData';
import { config } from '../config';

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
  async logs(filter: LogSearch): Promise<Sourced<Paginated<LogEntry>> & { meta: LogSearchMeta }> {
    const { cloudwatch } = getIntegrations();
    const res = await cloudwatch.getLogs({
      services: filter.services,
      environment: filter.environment,
      levels: filter.levels,
      search: filter.search,
      regex: filter.regex,
      regexMaxLength: config.logs.regexMaxLength,
      startTime: filter.from,
      endTime: filter.to,
      sort: filter.sort,
      // Adapters clamp to their own window cap (100 for mock/Urbani API, LOGS_INSIGHTS_MAX_RESULTS for Insights).
      limit: config.logs.source === 'insights' ? config.logs.insightsMaxResults : 100,
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
      meta: {
        applied: appliedFilters(filter),
        sort: filter.sort,
        total: all.length,
        truncated: res.meta.truncated ?? all.length >= 100,
        windowCap: res.meta.windowCap ?? 100,
        scope: res.meta.scope ?? 'Latest log window from the configured source.',
      },
    };
  },

  async metrics(filter: { service?: string; environment?: string }): Promise<Sourced<MetricSnapshot[]>> {
    const repos = getRepositories();
    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: await repos.metrics.query({ ...filter, limit: 300 }),
    };
  },

  async services(): Promise<Sourced<ServiceSummary[]>> {
    // QA exposes no /services endpoint, so the roster is config-authoritative:
    // derive `enabled` (membership in config.urbani.services) + `logGroup`
    // at read time (the SQLite row does not carry them).
    const repos = getRepositories();
    const data = (await repos.services.all()).map((s) => withRoster(s));
    return { source: 'MOCK', sourceNote: MOCK_NOTE, data };
  },

  async service(id: string): Promise<Sourced<ServiceSummary>> {
    const repos = getRepositories();
    const svc = await repos.services.findById(id);
    if (!svc) throw new NotFoundError(`Service not found: ${id}`);
    return { source: 'MOCK', sourceNote: MOCK_NOTE, data: withRoster(svc) };
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

/** Augment a roster row with the derived-at-read `enabled` + `logGroup` fields. */
function withRoster(s: ServiceSummary): ServiceSummary {
  return {
    ...s,
    enabled: config.urbani.services.includes(s.name),
    logGroup: config.urbani.logGroupFor(s.name),
  };
}
