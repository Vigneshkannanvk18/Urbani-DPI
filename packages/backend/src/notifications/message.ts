import type { PersistedAlert, Severity } from '@urbani/shared';

/** Channel-neutral notification content (DPI 2 item 6). Never contains secrets. */
export interface NotificationMessage {
  title: string;
  severity: Severity;
  service: string;
  environment: string;
  anomalyType: string;
  summary: string;
  probableCause: string | null;
  /** e.g. "85% (derived)"; null when the source reports none. */
  confidence: string | null;
  timestamp: string;
  link: string | null;
  isTest: boolean;
  alertId: string | null;
  /** True when this is a follow-up because the alert's severity rose after it was first notified. */
  escalated?: boolean;
}

const MAX_CAUSE = 300;
const MAX_SUMMARY = 500;

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Deep link to the alert in the dashboard; null when no base URL is configured. */
export function alertLink(baseUrl: string | null | undefined, alertId: string): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}/alerts/${encodeURIComponent(alertId)}`;
}

export function messageFromAlert(
  alert: PersistedAlert,
  opts: { baseUrl: string | null; source: 'LIVE' | 'MOCK'; escalated?: boolean },
): NotificationMessage {
  const pct = alert.confidence == null ? null : `${Math.round(alert.confidence * 100)}%`;
  return {
    title: `${opts.escalated ? '[ESCALATED] ' : ''}[${alert.severity}] ${alert.service}: ${alert.anomalyType}`,
    escalated: opts.escalated === true,
    severity: alert.severity,
    service: alert.service,
    environment: alert.environment,
    anomalyType: alert.anomalyType,
    summary: truncate(alert.summary, MAX_SUMMARY),
    probableCause: alert.probableCause ? truncate(alert.probableCause, MAX_CAUSE) : null,
    // The live QA source reports no confidence: a non-null value on a LIVE alert is a severity heuristic.
    confidence: pct === null ? null : opts.source === 'LIVE' ? `${pct} (derived)` : pct,
    timestamp: alert.timestamp,
    link: alertLink(opts.baseUrl, alert.alertId),
    isTest: false,
    alertId: alert.alertId,
  };
}

/** Clearly labelled test message; carries a SIMULATED marker and never creates an alert. */
export function testMessage(severity: Severity, baseUrl: string | null, now: string): NotificationMessage {
  return {
    title: '[TEST] Urbani Radar notification test',
    severity,
    service: 'notification-test',
    environment: 'n/a',
    anomalyType: 'SIMULATED',
    summary: 'SIMULATED: this is a test message sent from the Notifications page. No real incident exists.',
    probableCause: null,
    confidence: null,
    timestamp: now,
    link: baseUrl ? `${baseUrl.replace(/\/+$/, '')}/notifications` : null,
    isTest: true,
    alertId: null,
  };
}

/** Plain-text body (e-mail and Slack fallback text). */
export function plainText(m: NotificationMessage): string {
  const lines = [
    m.title,
    '',
    ...(m.escalated ? ['Severity increased since the previous notification for this alert.', ''] : []),
    `Severity: ${m.severity}`,
    `Service: ${m.service}`,
    `Environment: ${m.environment}`,
    `Anomaly type: ${m.anomalyType}`,
    `Time: ${m.timestamp}`,
    `Summary: ${m.summary}`,
  ];
  if (m.probableCause) lines.push(`Probable cause: ${m.probableCause}`);
  if (m.confidence) lines.push(`Confidence: ${m.confidence}`);
  if (m.link) lines.push('', `Open in dashboard: ${m.link}`);
  return lines.join('\n');
}

/** One-line description stored in the delivery log. */
export function logSummary(m: NotificationMessage): string {
  return `${m.title} (${m.environment})`.slice(0, 300);
}
