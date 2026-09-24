import type { Sourced, Paginated, PersistedAlert } from '@urbani/shared';
import { alertRepository, type AlertFilter } from '../repositories/alertRepository';
import { logRepository } from '../repositories/telemetryRepository';
import { auditRepository } from '../repositories/auditRepository';
import { NotFoundError } from '../lib/errors';
import { MOCK_NOTE } from '../integrations/mock/mockData';

/**
 * Alert service (Epic 5). Read + acknowledge only — NO automated remediation.
 * Acknowledgement is a human-in-the-loop action and is always audited.
 */
export const alertService = {
  list(filter: AlertFilter): Sourced<Paginated<PersistedAlert>> {
    const { items, total } = alertRepository.query(filter);
    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: {
        items,
        page: Math.max(filter.page ?? 1, 1),
        pageSize: Math.min(Math.max(filter.pageSize ?? 25, 1), 200),
        total,
      },
    };
  },

  get(alertId: string, actor: string): Sourced<PersistedAlert & { relatedLogs: ReturnType<typeof logRepository.byAlert> }> {
    const alert = alertRepository.findById(alertId);
    if (!alert) throw new NotFoundError(`Alert not found: ${alertId}`);
    auditRepository.record(actor, 'ALERT_VIEWED', alertId);
    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: { ...alert, relatedLogs: logRepository.byAlert(alertId) },
    };
  },

  acknowledge(alertId: string, actor: string): Sourced<PersistedAlert> {
    const updated = alertRepository.acknowledge(alertId, actor);
    if (!updated) throw new NotFoundError(`Alert not found: ${alertId}`);
    auditRepository.record(actor, 'ALERT_ACKNOWLEDGED', alertId);
    return { source: 'MOCK', sourceNote: MOCK_NOTE, data: updated };
  },
};
