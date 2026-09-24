import type { UrbaniIncidentAlert, LogEntry, MetricSnapshot } from '@urbani/shared';
import type { AdapterMeta } from '../types';

/**
 * AIProvider abstraction (Epic 8 / Phase 3).
 *
 * The dashboard and services MUST NOT know whether a finding came from
 * MockAIProvider or BedrockAIProvider. Both satisfy this single contract.
 *
 *   AIProvider
 *     ├── MockAIProvider     (Phase 1 — deterministic, no cost)
 *     ├── BedrockAIProvider  (Phase 3 — real, config-driven model)
 *     └── FutureProvider
 */

export interface AnalyzeTelemetryInput {
  logs: LogEntry[];
  metrics: MetricSnapshot[];
  service: string;
  environment: string;
  /** Optional prior alerts / pattern memory to ground the analysis. */
  historicalContext?: UrbaniIncidentAlert[];
}

/**
 * Result of an analysis run. `alert` is null when no anomaly is detected —
 * mirrors the documented NO_ANOMALY_DETECTED grounding rule (the model must not
 * invent findings without log evidence).
 */
export interface AnalyzeTelemetryResult {
  alert: UrbaniIncidentAlert | null;
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  guardrailIntervened: boolean;
  meta: AdapterMeta;
}

export interface AIProvider {
  readonly name: string;
  readonly modelId: string;
  analyzeTelemetry(input: AnalyzeTelemetryInput): Promise<AnalyzeTelemetryResult>;
}
