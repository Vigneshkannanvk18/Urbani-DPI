import type { DashboardSummary, Sourced, MetricSnapshot } from '@urbani/shared';
import { serviceRepository, metricRepository } from '../repositories/telemetryRepository';
import { alertRepository } from '../repositories/alertRepository';
import { aiRepository } from '../repositories/aiRepository';
import { MOCK_NOTE } from '../integrations/mock/mockData';

/**
 * Dashboard service (Epic 4). Aggregates counts and health for the overview.
 * Everything derived from seeded data is labelled MOCK.
 */
export const dashboardService = {
  summary(): Sourced<DashboardSummary> {
    const totalServices = serviceRepository.count();
    const activeAlerts = alertRepository.countActive();
    const criticalAlerts = alertRepository.countBySeverity('CRITICAL');
    const services = serviceRepository.all();

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
        recentIncidents: alertRepository.query({ pageSize: 200 }).total,
        aiAnalyses: aiRepository.count(),
        systemHealth,
      },
    };
  },

  /** Observability rollup for the overview charts. */
  health(): Sourced<{ services: ReturnType<typeof serviceRepository.all>; recentMetrics: MetricSnapshot[] }> {
    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: {
        services: serviceRepository.all(),
        recentMetrics: metricRepository.query({ limit: 60 }),
      },
    };
  },
};
