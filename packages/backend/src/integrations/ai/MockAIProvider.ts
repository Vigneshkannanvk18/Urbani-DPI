import type { UrbaniIncidentAlert, Severity } from '@urbani/shared';
import type { AIProvider, AnalyzeTelemetryInput, AnalyzeTelemetryResult } from './AIProvider';
import { MOCK_NOTE } from '../mock/mockData';

/**
 * MockAIProvider (Phase 1 / Phase 3 placeholder).
 *
 * Deterministic, evidence-based, zero-cost analyzer. It mirrors the documented
 * AI safeguards so the dashboard behaves exactly as it will with real Bedrock:
 *   - Evidence-based: only cites log lines actually present in the input.
 *   - Grounding rule: no error evidence => returns null (NO_ANOMALY_DETECTED).
 *   - Advisory only: recommendedActions never include automated remediation.
 *   - Deterministic: same input => same output (no randomness).
 *
 * The dashboard cannot tell this apart from BedrockAIProvider — both implement
 * the same AIProvider contract and return the same UrbaniIncidentAlert shape.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'MockAIProvider';

  constructor(readonly modelId: string) {}

  async analyzeTelemetry(input: AnalyzeTelemetryInput): Promise<AnalyzeTelemetryResult> {
    const errorLogs = input.logs.filter((l) => l.level === 'ERROR' || l.level === 'FATAL');
    const warnLogs = input.logs.filter((l) => l.level === 'WARN');

    // Grounding rule: without error evidence, do not fabricate an anomaly.
    if (errorLogs.length === 0) {
      return {
        alert: null,
        modelId: this.modelId,
        provider: this.name,
        inputTokens: this.estimateTokens(input),
        outputTokens: 12,
        guardrailIntervened: false,
        meta: { source: 'MOCK', note: MOCK_NOTE },
      };
    }

    const evidence = [...errorLogs, ...warnLogs]
      .slice(0, 5)
      .map((l) => `${l.timestamp} ${l.level} ${l.message}`);

    const anomalyType = this.classify(errorLogs.map((l) => l.message).join(' '));
    const severity = this.severityFor(anomalyType, errorLogs.length, input);

    const alert: UrbaniIncidentAlert = {
      alertId: `ALT-${input.service}-${Date.parse(input.logs[0]?.timestamp ?? new Date().toISOString())}`,
      timestamp: new Date().toISOString(),
      service: input.service,
      environment: input.environment,
      severity,
      anomalyType,
      summary: `${errorLogs.length} error-level log lines detected for ${input.service} (${anomalyType}).`,
      evidence,
      probableCause: this.causeFor(anomalyType),
      recommendedActions: this.actionsFor(anomalyType), // advisory only
      confidence: Math.min(0.6 + errorLogs.length * 0.05, 0.95),
      modelId: this.modelId,
    };

    return {
      alert,
      modelId: this.modelId,
      provider: this.name,
      inputTokens: this.estimateTokens(input),
      outputTokens: 300,
      guardrailIntervened: false,
      meta: { source: 'MOCK', note: MOCK_NOTE },
    };
  }

  private estimateTokens(input: AnalyzeTelemetryInput): number {
    const chars = input.logs.reduce((n, l) => n + l.message.length, 0);
    return Math.min(Math.ceil(chars / 4), 1500);
  }

  private classify(text: string): string {
    const t = text.toLowerCase();
    if (t.includes('connection') && (t.includes('pool') || t.includes('timeout'))) {
      return 'DatabaseConnectionTimeout';
    }
    if (t.includes('memory') || t.includes('heap')) return 'MemoryPressure';
    if (t.includes('nullreference') || t.includes('unhandled')) return 'ElevatedErrorRate';
    return 'GenericApplicationError';
  }

  private severityFor(
    anomalyType: string,
    errorCount: number,
    input: AnalyzeTelemetryInput,
  ): Severity {
    if (anomalyType === 'DatabaseConnectionTimeout' && input.environment.includes('production')) {
      return 'CRITICAL';
    }
    if (errorCount >= 3) return 'HIGH';
    if (errorCount >= 1) return 'MEDIUM';
    return 'LOW';
  }

  private causeFor(anomalyType: string): string {
    switch (anomalyType) {
      case 'DatabaseConnectionTimeout':
        return 'Connection pool exhaustion, likely from unclosed DB sessions under load.';
      case 'MemoryPressure':
        return 'Possible memory leak or under-provisioned instance for current load.';
      case 'ElevatedErrorRate':
        return 'A recent change likely introduced an unhandled exception in a hot path.';
      default:
        return 'Unclassified application error pattern requires engineer review.';
    }
  }

  private actionsFor(anomalyType: string): string[] {
    // NOTE: advisory only. NO automated production remediation anywhere.
    switch (anomalyType) {
      case 'DatabaseConnectionTimeout':
        return [
          'Check active DB connection metrics and compare against pool max size.',
          'Review recent deploys for unclosed connections or missing cleanup.',
          'Consider temporarily increasing pool size while investigating.',
        ];
      case 'MemoryPressure':
        return ['Capture a heap snapshot.', 'Compare memory trend against last known-good build.'];
      case 'ElevatedErrorRate':
        return [
          'Inspect the failing code path for null/error handling.',
          'Correlate the error spike with the most recent deployment.',
        ];
      default:
        return ['Review the cited log lines and correlate with recent changes.'];
    }
  }
}
