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

/** A prior turn in the chat conversation (for multi-turn context). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskLogsInput {
  question: string;
  /** The log window the answer must be grounded in. */
  logs: LogEntry[];
  service: string;
  environment: string;
  /** Prior conversation turns (optional). */
  history?: ChatTurn[];
}

/**
 * Result of a log chatbot question. `answer` is grounded ONLY in the supplied
 * logs; `citations` are the specific log lines the answer relied on. Advisory
 * only — the assistant never triggers actions.
 */
export interface AskLogsResult {
  answer: string;
  citations: string[];
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
  /** Answer a natural-language question about the provided log window. */
  askLogs(input: AskLogsInput): Promise<AskLogsResult>;
}
