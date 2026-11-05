import type { DashboardSummary, Sourced, MetricSnapshot, ServiceSummary } from '@urbani/shared';
import { getRepositories } from '../repositories';
import { MOCK_NOTE } from '../integrations/mock/mockData';

/**
 * Dashboard service (Epic 4). Aggregates counts and health for the overview.
 * Everything derived from seeded data is labelled MOCK.
 */
export const dashboardService = {
  async summary(): Promise<Sourced<DashboardSummary>> {
    const repos = getRepositories();
    const totalServices = await repos.services.count();
    const activeAlerts = await repos.alerts.countActive();
    const criticalAlerts = await repos.alerts.countBySeverity('CRITICAL');
    const services = await repos.services.all();

    const down = services.filter((s) => s.status === 'DOWN').length;
    const degraded = services.filter((s) => s.status === 'DEGRADED').length;
    const systemHealth: DashboardSummary['systemHealth'] =
      down > 0 ? 'DOWN' : degraded > 0 ? 'DEGRADED' : totalServices > 0 ? 'HEALTHY' : 'UNKNOWN';

    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: {
        totalServices,
        activeAlerts,
        criticalAlerts,
        recentIncidents: await repos.alerts.countAll(),
        aiAnalyses: await repos.aiAnalyses.count(),
        systemHealth,
      },
    };
  },

  /** Observability rollup for the overview charts. */
  async health(): Promise<Sourced<{ services: ServiceSummary[]; recentMetrics: MetricSnapshot[] }>> {
    const repos = getRepositories();
    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: {
        services: await repos.services.all(),
        recentMetrics: await repos.metrics.query({ limit: 60 }),
      },
    };
  },
};
