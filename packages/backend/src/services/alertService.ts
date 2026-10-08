import type { Sourced, Paginated, PersistedAlert } from '@urbani/shared';
import { alertRepository, type AlertFilter } from '../repositories/alertRepository';
import { logRepository } from '../repositories/telemetryRepository';
import { auditRepository } from '../repositories/auditRepository';
import { NotFoundError } from '../lib/errors';
import { MOCK_NOTE } from '../integrations/mock/mockData';
import { config } from '../config';
import { getIntegrations } from '../integrations';
import { logger } from '../lib/logger';

/**
 * Alert service (Epic 5). Read + acknowledge only — NO automated remediation.
 * Acknowledgement is a human-in-the-loop action and is always audited.
 *
 * Live provenance (Phase 3): when INTEGRATION_MODE=live and the Urbani API is
 * configured, real Bedrock-generated alerts are INGESTED-ON-READ into SQLite via
 * the live alerts adapter before each list/get. Rationale over pure pass-through:
 * acknowledge, detail, relatedLogs, pagination and filtering already depend on the
 * repository, so routing live data through the SAME persistence boundary keeps all
 * of that working UNCHANGED while acknowledge still persists. The sync preserves an
 * existing row's lifecycle (see alertRepository.upsertLivePreservingStatus), so a
 * re-sync never un-acknowledges an alert. No schema migration is required.
 */

const LIVE_NOTE = 'Live AI-generated incidents (Amazon Bedrock Nova 2 Lite).';

function liveConfigured(): boolean {
  return config.integrationMode === 'live' && config.urbani.logsConfigured;
}

/**
 * In live mode, pull the latest + history alerts and upsert them into SQLite so
 * the existing read paths serve real data. Failures are swallowed (the adapter
 * already degrades to stale/empty) so the Alerts page never 500s.
 */
async function syncLiveAlerts(): Promise<void> {
  if (!liveConfigured()) return;
  const { urbaniAlerts } = getIntegrations();
  if (!urbaniAlerts) return;
  try {
    const [latest, history] = await Promise.all([
      urbaniAlerts.getLatest(),
      urbaniAlerts.getHistory(config.urbani.alertsHistoryLimit),
    ]);
    // De-dup by alertId (latest may also appear in history); body is identical.
    const byId = new Map<string, (typeof history)[number]>();
    for (const a of [...history, ...latest]) byId.set(a.alertId, a);
    for (const alert of byId.values()) {
      alertRepository.upsertLivePreservingStatus(alert);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    logger.warn('Live alert sync failed; serving previously stored alerts', { message });
  }
}

function sourceLabel(): { source: Sourced<unknown>['source']; note: string } {
  return liveConfigured()
    ? { source: 'LIVE', note: LIVE_NOTE }
    : { source: 'MOCK', note: MOCK_NOTE };
}

export const alertService = {
  async list(filter: AlertFilter): Promise<Sourced<Paginated<PersistedAlert>>> {
    await syncLiveAlerts();
    const { items, total } = alertRepository.query(filter);
    const { source, note } = sourceLabel();
    return {
      source,
      sourceNote: note,
      data: {
        items,
        page: Math.max(filter.page ?? 1, 1),
        pageSize: Math.min(Math.max(filter.pageSize ?? 25, 1), 200),
        total,
      },
    };
  },

  async get(
    alertId: string,
    actor: string,
  ): Promise<Sourced<PersistedAlert & { relatedLogs: ReturnType<typeof logRepository.byAlert> }>> {
    await syncLiveAlerts();
    const alert = alertRepository.findById(alertId);
    if (!alert) throw new NotFoundError(`Alert not found: ${alertId}`);
    auditRepository.record(actor, 'ALERT_VIEWED', alertId);
    const { source, note } = sourceLabel();
    return {
      source,
      sourceNote: note,
      data: { ...alert, relatedLogs: logRepository.byAlert(alertId) },
    };
  },

  async acknowledge(alertId: string, actor: string): Promise<Sourced<PersistedAlert>> {
    // Ensure the alert exists locally (live rows are ingested on read/ack).
    await syncLiveAlerts();
    const updated = alertRepository.acknowledge(alertId, actor);
    if (!updated) throw new NotFoundError(`Alert not found: ${alertId}`);
    auditRepository.record(actor, 'ALERT_ACKNOWLEDGED', alertId);
    const { source, note } = sourceLabel();
    return { source, sourceNote: note, data: updated };
  },
};
