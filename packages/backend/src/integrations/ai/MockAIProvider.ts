import type { UrbaniIncidentAlert, Severity } from '@urbani/shared';
import type {
  AIProvider,
  AnalyzeTelemetryInput,
  AnalyzeTelemetryResult,
  AskLogsInput,
  AskLogsResult,
} from './AIProvider';
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

  /**
   * Answer a natural-language question about the supplied log window.
   * Deterministic, evidence-grounded (cites only provided log lines), advisory
   * only. Mirrors how the future BedrockAIProvider will behave so the chat UI
   * needs no changes when the real model is wired in.
   */
  async askLogs(input: AskLogsInput): Promise<AskLogsResult> {
    const q = input.question.toLowerCase();
    const logs = input.logs;
    const errors = logs.filter((l) => l.level === 'ERROR' || l.level === 'FATAL');
    const warns = logs.filter((l) => l.level === 'WARN');
    const fmt = (l: (typeof logs)[number]) => `${l.timestamp} ${l.level} ${l.message}`;

    // Grounding rule: with no logs in the window, refuse to speculate.
    if (logs.length === 0) {
      return this.buildAnswer(
        input,
        `There are no logs in the current window for ${input.service} (${input.environment}), ` +
          `so I can't answer from evidence. When the application emits logs, ask again and I'll ` +
          `ground my answer in those lines.`,
        [],
      );
    }

    let answer: string;
    let citations: string[];

    if (q.includes('error') || q.includes('fail') || q.includes('exception') || q.includes('wrong')) {
      citations = errors.slice(0, 5).map(fmt);
      answer = errors.length
        ? `I found ${errors.length} error-level log line(s) in this window. The most relevant ` +
          `appear to relate to "${this.topKeyword(errors)}". Review the cited lines below and ` +
          `correlate them with recent deployments. This is advisory — please verify before acting.`
        : `No error- or fatal-level lines are present in this window; the ${logs.length} entries are ` +
          `informational/warnings. Nothing indicates a failure right now.`;
    } else if (q.includes('summar') || q.includes('overview') || q.includes("what's happening") || q.includes('status')) {
      citations = [...errors, ...warns].slice(0, 5).map(fmt);
      answer =
        `In this window for ${input.service}: ${logs.length} total lines — ` +
        `${errors.length} error, ${warns.length} warning, ${logs.length - errors.length - warns.length} info/debug. ` +
        (errors.length ? `Errors dominate around "${this.topKeyword(errors)}". ` : `No errors detected. `) +
        `See cited lines for evidence.`;
    } else if (q.includes('how many') || q.includes('count') || q.includes('number of')) {
      citations = errors.slice(0, 3).map(fmt);
      answer =
        `Counts for this window — total: ${logs.length}, errors: ${errors.length}, ` +
        `warnings: ${warns.length}. (Counts are exact for the fetched window only.)`;
    } else if (q.includes('recommend') || q.includes('fix') || q.includes('what should') || q.includes('next')) {
      const kw = this.topKeyword(errors.length ? errors : logs);
      citations = errors.slice(0, 3).map(fmt);
      answer =
        `Based on the evidence, I'd suggest: (1) inspect the cited "${kw}" lines, ` +
        `(2) correlate with the most recent deploy, (3) check the related subsystem's health metrics. ` +
        `These are advisory steps for a human to review — I don't perform any automated remediation.`;
    } else {
      // Generic: keyword-match the question against the log messages.
      const terms = q.split(/\W+/).filter((w) => w.length > 3);
      const matched = logs.filter((l) => terms.some((t) => l.message.toLowerCase().includes(t)));
      citations = (matched.length ? matched : logs).slice(0, 5).map(fmt);
      answer = matched.length
        ? `I found ${matched.length} log line(s) matching your question. See the cited lines below; ` +
          `my answer is grounded only in these entries.`
        : `I couldn't find log lines directly matching that in the current window. Here are the most ` +
          `recent ${Math.min(logs.length, 5)} lines for context. Try asking about errors, a summary, or counts.`;
    }

    return this.buildAnswer(input, answer, citations);
  }

  private buildAnswer(input: AskLogsInput, answer: string, citations: string[]): AskLogsResult {
    const inputTokens = Math.min(
      Math.ceil((input.question.length + input.logs.reduce((n, l) => n + l.message.length, 0)) / 4),
      1500,
    );
    return {
      answer,
      citations,
      modelId: this.modelId,
      provider: this.name,
      inputTokens,
      outputTokens: Math.ceil(answer.length / 4),
      guardrailIntervened: false,
      meta: { source: 'MOCK', note: MOCK_NOTE },
    };
  }

  /** Cheap "topic" extraction: the most frequent salient word across messages. */
  private topKeyword(logs: { message: string }[]): string {
    const counts = new Map<string, number>();
    for (const l of logs) {
      for (const w of l.message.toLowerCase().split(/\W+/)) {
        if (w.length > 4) counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
    let best = 'the logged errors';
    let max = 0;
    for (const [w, c] of counts) if (c > max) ((max = c), (best = w));
    return best;
  }
}
