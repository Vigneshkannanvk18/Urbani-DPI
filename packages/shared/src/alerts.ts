import { z } from 'zod';

/**
 * UrbaniIncidentAlert — the canonical AI output contract.
 *
 * Source of truth: "Urbani AWS Architecture Proposal" section 10.5 (Proposed Output
 * JSON Schema, title "UrbaniIncidentAlert"). This structure is the stable contract
 * between the AI provider (Mock now, Bedrock later) and everything downstream:
 * persistence, API, and dashboard. Do NOT change field names/shape without a
 * corresponding contract/version bump — Phase 2 Bedrock output must map onto this.
 */

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Lifecycle status of an alert inside the Admin Dashboard (advisory / human-in-loop).
 * NOTE: acknowledgement/resolution are human actions only — there is NO automated
 * remediation anywhere in this system (architecture principle: Human-in-the-Loop).
 */
export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** As emitted by the AI provider, before persistence assigns lifecycle status. */
export const urbaniIncidentAlertSchema = z.object({
  alertId: z.string(),
  timestamp: z.string().datetime({ offset: true }),
  service: z.string(),
  environment: z.string(),
  severity: z.enum(SEVERITIES),
  anomalyType: z.string(),
  summary: z.string(),
  evidence: z.array(z.string()),
  probableCause: z.string(),
  recommendedActions: z.array(z.string()),
  // Nullable: the live QA /alerts API returns no confidence score. A fixed
  // numeric default would paint a fabricated precision onto a LIVE incident, so
  // "unknown" is modelled honestly as null (rendered '—' in the UI).
  confidence: z.number().min(0).max(1).nullable(),
  modelId: z.string(),
});

export type UrbaniIncidentAlert = z.infer<typeof urbaniIncidentAlertSchema>;

/** Sentinel returned by the AI provider when logs contain no error evidence. */
export const NO_ANOMALY_DETECTED = 'NO_ANOMALY_DETECTED' as const;

/** Persisted/enriched alert as served by the API and rendered by the dashboard. */
export const persistedAlertSchema = urbaniIncidentAlertSchema.extend({
  status: z.enum(ALERT_STATUSES),
  acknowledgedBy: z.string().nullable().optional(),
  acknowledgedAt: z.string().nullable().optional(),
  relatedLogIds: z.array(z.string()).default([]),
  relatedMetricIds: z.array(z.string()).default([]),
});

export type PersistedAlert = z.infer<typeof persistedAlertSchema>;
