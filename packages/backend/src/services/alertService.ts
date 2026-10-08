import type { Sourced, Paginated, PersistedAlert, UrbaniIncidentAlert, LogEntry } from '@urbani/shared';
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

/** Cap on the number of derived evidence lines persisted per alert. */
const MAX_EVIDENCE_LINES = 10;
/** Timestamp window (ms) around an alert within which a log line may justify it. */
const EVIDENCE_WINDOW_MS = 30 * 60_000;

function liveConfigured(): boolean {
  return config.integrationMode === 'live' && config.urbani.logsConfigured;
}

/**
 * Heuristically select live log lines that plausibly justify a live alert.
 * Defensive and case-insensitive — a best-effort correlation, NOT exact
 * matching. A line qualifies when it is the SAME service, within a reasonable
 * timestamp window around the alert, AND matches a keyword/HTTP-status token
 * derived from the alert's anomalyType / summary. Returns at most
 * MAX_EVIDENCE_LINES, newest-first. Never fabricates lines.
 */
export function matchEvidence(alert: UrbaniIncidentAlert, logs: LogEntry[]): LogEntry[] {
  const haystackForTokens = `${alert.anomalyType} ${alert.summary}`.toLowerCase();
  const tokens = new Set<string>();

  // Any 3-digit HTTP status in the anomaly/summary (e.g. "HTTP_403" -> "403").
  for (const m of haystackForTokens.matchAll(/(?:http[_-]?)?(\d{3})/gi)) {
    tokens.add(m[1]);
  }
  // Split anomaly type into word tokens (camelCase, snake_case, spaces).
  for (const w of alert.anomalyType
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/i)) {
    const t = w.toLowerCase();
    if (t.length >= 4) tokens.add(t);
  }
  // Common anomaly keywords present in the text.
  for (const kw of ['error', 'timeout', 'database', 'connection', 'slowdown', 'latency', 'fail']) {
    if (haystackForTokens.includes(kw)) tokens.add(kw);
  }

  const alertMs = Date.parse(alert.timestamp);
  const hasWindow = !Number.isNaN(alertMs);

  const matched = logs.filter((log) => {
    if (log.service !== alert.service) return false;

    // Timestamp window (defensive about unparseable timestamps: if either side
    // is unparseable, do not reject on time alone).
    const logMs = Date.parse(log.timestamp);
    if (hasWindow && !Number.isNaN(logMs) && Math.abs(logMs - alertMs) > EVIDENCE_WINDOW_MS) {
      return false;
    }

    // Keyword / status match (case-insensitive substring).
    const message = log.message.toLowerCase();
    if (tokens.size === 0) return false;
    for (const t of tokens) {
      if (message.includes(t)) return true;
    }
    return false;
  });

  // Prefer newest (logs already arrive newest-first from the adapter; sort to be safe).
  return matched
    .slice()
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
    .slice(0, MAX_EVIDENCE_LINES);
}

/**
 * In live mode, pull the latest + history alerts and upsert them into SQLite so
 * the existing read paths serve real data. Failures are swallowed (the adapter
 * already degrades to stale/empty) so the Alerts page never 500s.
 */
async function syncLiveAlerts(): Promise<void> {
  if (!liveConfigured()) return;
  const { urbaniAlerts, cloudwatch } = getIntegrations();
  if (!urbaniAlerts) return;
  try {
    const [latest, history] = await Promise.all([
      urbaniAlerts.getLatest(),
      urbaniAlerts.getHistory(config.urbani.alertsHistoryLimit),
    ]);
    // De-dup by alertId (latest may also appear in history); body is identical.
    const byId = new Map<string, (typeof history)[number]>();
    for (const a of [...history, ...latest]) byId.set(a.alertId, a);

    // Clear stale seeded MOCK alerts now that a live fetch has succeeded, so the
    // Alerts page shows only LIVE incidents in live mode. Guarded by the
    // liveConfigured() check above; LIVE rows are never deleted. Done inside the
    // try so a failed upstream fetch never strands the page empty.
    alertRepository.deleteByDataSource('MOCK');

    for (const alert of byId.values()) {
      alertRepository.upsertLivePreservingStatus(alert);
    }

    // Correlate each live alert to recent live log lines so the Evidence card and
    // relatedLogs are backed by real data (never fabricated). This is best-effort:
    // a correlation failure must not 500 the Alerts page.
    await correlateLiveAlerts([...byId.values()], cloudwatch);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    logger.warn('Live alert sync failed; serving previously stored alerts', { message });
  }
}

/**
 * For each live alert, fetch recent live logs for its service and persist matched
 * evidence BOTH ways the schema supports, idempotently:
 *   - alert_evidence: the matched log MESSAGE strings (populates Alert.evidence[]).
 *   - log_references.alert_id: stamped for matched rows (so byAlert returns them).
 *
 * NOTE on the two tables: LIVE adapter logs are NOT persisted in log_references,
 * so linkLogsToAlert only stamps ids that already exist there (seeded rows). The
 * Evidence card is driven by alert_evidence and is therefore always populated for
 * matched LIVE lines; relatedLogs populates only for ids present in the table.
 * If no logs match, evidence/links are cleared — never fabricated.
 */
async function correlateLiveAlerts(
  alerts: UrbaniIncidentAlert[],
  cloudwatch: ReturnType<typeof getIntegrations>['cloudwatch'],
): Promise<void> {
  // Fetch recent logs once per distinct service.
  const services = [...new Set(alerts.map((a) => a.service))];
  const logsByService = new Map<string, LogEntry[]>();
  await Promise.all(
    services.map(async (service) => {
      try {
        const res = await cloudwatch.getLogs({ service, limit: 100 });
        logsByService.set(service, res.value);
      } catch {
        logsByService.set(service, []);
      }
    }),
  );

  for (const alert of alerts) {
    try {
      const logs = logsByService.get(alert.service) ?? [];
      const matched = matchEvidence(alert, logs);
      // Idempotent: replace prior derived evidence + clear/re-link related logs.
      alertRepository.replaceDerivedEvidence(
        alert.alertId,
        matched.map((l) => l.message),
      );
      logRepository.clearAlertLinks(alert.alertId);
      logRepository.linkLogsToAlert(
        alert.alertId,
        matched.map((l) => l.id),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn('Live alert correlation failed for one alert; continuing', {
        alertId: alert.alertId,
        message,
      });
    }
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
