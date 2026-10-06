import type {
  AIProvider,
  AnalyzeTelemetryInput,
  AnalyzeTelemetryResult,
  AskLogsInput,
  AskLogsResult,
} from '../ai/AIProvider';
import { MockAIProvider } from '../ai/MockAIProvider';
import { logger } from '../../lib/logger';

/**
 * HttpUrbaniChatProvider (Phase 3 — real AI chat via Amazon Bedrock Nova Lite).
 *
 * Implements the SAME AIProvider contract as MockAIProvider. The chatbot path
 * (chatService.ask -> askLogs) POSTs the question to the live API Gateway
 * endpoint {base}/chat, which grounds the answer server-side on the current
 * Bedrock-analyzed log window and returns the answer + evidence. Nothing above
 * this boundary changes: the /assistant widget, SourceBadge, citations and
 * conversation state keep consuming the same AskLogsResult shape.
 *
 * analyzeTelemetry has NO live endpoint (the proposal pipeline runs analyze
 * server-side in Lambda, not through this API), so it DELEGATES to an internal
 * MockAIProvider. That keeps the AIProvider contract fully satisfied without
 * fabricating a Bedrock analyze call.
 *
 * SECURITY:
 *  - The x-api-key is read from config (env) only; never hardcoded, never
 *    logged, never returned to the browser, never placed in meta/answer/throws.
 *  - On network error / non-2xx the chat does NOT crash chatService; it falls
 *    back to the internal MockAIProvider so the user still gets an honest,
 *    evidence-grounded answer from the fetched window.
 *
 * No-fabrication: the live endpoint returns answer "No log evidence was found
 * in the current log window.", evidence: [], modelId: null when the window is
 * empty — this is mapped FAITHFULLY (citations stay []), never embellished.
 */

interface UrbaniChatResponse {
  service_id?: string;
  window_start?: string;
  window_end?: string;
  log_count?: string | number;
  answer?: string;
  evidence?: unknown;
  confidence?: number;
  advisory?: boolean;
  modelId?: string | null;
}

export class HttpUrbaniChatProvider implements AIProvider {
  readonly name = 'HttpUrbaniChatProvider';
  readonly modelId: string;

  /** Deterministic fallback used for analyze + on any live chat failure. */
  private readonly fallback: MockAIProvider;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly service: string,
    modelId: string,
    private readonly timeoutMs: number,
  ) {
    this.modelId = modelId;
    this.fallback = new MockAIProvider(modelId);
  }

  /**
   * No live analyze endpoint exists — the server-side proposal pipeline (Collector
   * -> Bedrock -> Alert Writer) produces alerts out-of-band. Delegate to the
   * deterministic mock so the contract is satisfied honestly.
   */
  async analyzeTelemetry(input: AnalyzeTelemetryInput): Promise<AnalyzeTelemetryResult> {
    return this.fallback.analyzeTelemetry(input);
  }

  /**
   * Answer a question via the live POST {base}/chat. The AWS endpoint grounds on
   * its OWN current Bedrock log window (not the logs we fetched for context), so
   * we send only { service, question }. On any failure we fall back to Mock so
   * the chat never 500s.
   */
  async askLogs(input: AskLogsInput): Promise<AskLogsResult> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ service: this.service, question: input.question }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Do NOT include headers/key in the warning.
        logger.warn('Urbani chat API non-2xx; falling back to deterministic answer', {
          status: res.status,
          service: this.service,
        });
        return this.fallback.askLogs(input);
      }

      const body = (await res.json()) as UrbaniChatResponse;
      return this.mapResponse(input, body);
    } catch (err) {
      // Never echo the key or a raw stack; a short safe message only.
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn('Urbani chat API request failed; falling back to deterministic answer', {
        service: this.service,
        message,
      });
      return this.fallback.askLogs(input);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Map the live /chat response onto AskLogsResult (faithful, no fabrication). */
  private mapResponse(input: AskLogsInput, body: UrbaniChatResponse): AskLogsResult {
    const answer =
      typeof body.answer === 'string' && body.answer.length > 0
        ? body.answer
        : 'No log evidence was found in the current log window.';

    // evidence[] -> citations (string[]). NEVER synthesize entries.
    const citations = Array.isArray(body.evidence) ? body.evidence.map((e) => String(e)) : [];

    // AWS returns modelId: null on the empty-window response; surface the real
    // configured model label without claiming any evidence.
    const modelId =
      typeof body.modelId === 'string' && body.modelId.length > 0 ? body.modelId : this.modelId;

    // Token counts are not returned by AWS; estimate like Mock for usage/audit.
    const inputTokens = Math.min(Math.ceil(input.question.length / 4), 1500);
    const outputTokens = Math.ceil(answer.length / 4);

    return {
      answer,
      citations,
      modelId,
      provider: this.name,
      inputTokens,
      outputTokens,
      // AWS /chat does not expose a guardrail-intervention flag.
      guardrailIntervened: false,
      meta: { source: 'LIVE', note: 'Live Urbani chat (Amazon Bedrock Nova Lite).' },
    };
  }
}
