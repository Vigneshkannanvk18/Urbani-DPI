import type {
  AIProvider,
  AnalyzeTelemetryInput,
  AnalyzeTelemetryResult,
  AskLogsInput,
  AskLogsResult,
} from '../ai/AIProvider';
import { MockAIProvider } from '../ai/MockAIProvider';
import { ServiceUnavailableError } from '../../lib/errors';
import { logger } from '../../lib/logger';

/**
 * HttpUrbaniChatProvider (Phase 3 — real AI chat via Amazon Bedrock Nova 2 Lite).
 *
 * Implements the SAME AIProvider contract as MockAIProvider. The chatbot path
 * (chatService.ask -> askLogs) POSTs the question to the live QA API Gateway
 * endpoint {base}/chat, which grounds the answer server-side on recent logs +
 * alerts and returns the real Nova 2 Lite markdown answer. Nothing above this
 * boundary changes: the /assistant widget, SourceBadge and conversation state
 * keep consuming the same AskLogsResult shape.
 *
 * analyzeTelemetry has NO live endpoint (the pipeline runs analyze server-side
 * in Lambda, not through this API), so it DELEGATES to an internal
 * MockAIProvider. That keeps the AIProvider contract fully satisfied without
 * fabricating a Bedrock analyze call.
 *
 * SECURITY:
 *  - The x-api-key is read from config (env) only; never hardcoded, never
 *    logged, never returned to the browser, never placed in meta/answer/throws.
 *  - There is NO mock-answer fallback in live mode: on non-2xx / network error /
 *    timeout / abort / unmappable-2xx body, askLogs THROWS ServiceUnavailableError
 *    so chatService surfaces a controlled HTTP 503 "temporarily unavailable" —
 *    never a fabricated/mock answer, never a 500, never a key leak.
 */

interface UrbaniChatResponse {
  service_id?: string;
  question?: string;
  answer?: string;
  // Defensive aliases in case the field name differs on the wire.
  response?: string;
  message?: string;
  text?: string;
  content?: string;
  // evidence is an OBJECT OF COUNTS, not an array of citations.
  evidence?: { log_windows?: unknown; alerts?: unknown };
  model_id?: string;
  // Tolerate a legacy camelCase key defensively.
  modelId?: string | null;
}

export class HttpUrbaniChatProvider implements AIProvider {
  readonly name = 'HttpUrbaniChatProvider';
  readonly modelId: string;

  /** Deterministic provider used ONLY for analyzeTelemetry delegation. */
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
   * No live analyze endpoint exists — the server-side pipeline (Collector ->
   * Bedrock -> Alert Writer) produces alerts out-of-band. Delegate to the
   * deterministic mock so the contract is satisfied honestly (labelled MOCK).
   */
  async analyzeTelemetry(input: AnalyzeTelemetryInput): Promise<AnalyzeTelemetryResult> {
    return this.fallback.analyzeTelemetry(input);
  }

  /**
   * Answer a question via the live POST {base}/chat for the SELECTED service.
   * The QA endpoint grounds server-side on recent logs + alerts and returns the
   * real Nova 2 Lite markdown answer. On ANY failure this throws
   * ServiceUnavailableError (no mock answer).
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
        // Send the SELECTED service (presence-only resolve) + question. No minutes.
        body: JSON.stringify({
          service: this.resolveService(input.service),
          question: input.question,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Do NOT include headers/key in the warning.
        logger.warn('Urbani chat API non-2xx; surfacing honest unavailable', {
          status: res.status,
          service: this.resolveService(input.service),
        });
        throw new ServiceUnavailableError(
          'The AI assistant is temporarily unavailable. Please try again.',
        );
      }

      const body = (await res.json()) as UrbaniChatResponse;
      return this.mapResponse(input, body);
    } catch (err) {
      if (err instanceof ServiceUnavailableError) throw err;
      // Network error / timeout / abort / unmappable body: honest 503, no key.
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn('Urbani chat API request failed; surfacing honest unavailable', {
        service: this.resolveService(input.service),
        message,
      });
      throw new ServiceUnavailableError(
        'The AI assistant is temporarily unavailable. Please try again.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Presence-only service resolution: send the provided service verbatim when it
   * is a non-empty string, else the constructor default. Enablement gating is
   * chatService's responsibility — this must NEVER rewrite a provided service
   * back to the default (that would send a valid payments request to main).
   */
  private resolveService(s: string | undefined): string {
    return typeof s === 'string' && s.trim() ? s : this.service;
  }

  /** Map the live /chat 200 response onto AskLogsResult (faithful, no fabrication). */
  private mapResponse(input: AskLogsInput, body: UrbaniChatResponse): AskLogsResult {
    const answer = this.resolveAnswer(body);
    if (!answer) {
      // A 2xx body with no recognizable answer field is a shape mismatch, NOT a
      // valid empty answer — surface an honest 503, never a canned LIVE answer.
      logger.warn('Urbani chat API returned a 2xx body with no recognizable answer field');
      throw new ServiceUnavailableError(
        'The AI assistant is temporarily unavailable. Please try again.',
      );
    }

    // Model id: snake_case model_id (QA), else legacy modelId, else configured label.
    const modelId =
      (typeof body.model_id === 'string' && body.model_id.length > 0 && body.model_id) ||
      (typeof body.modelId === 'string' && body.modelId.length > 0 && body.modelId) ||
      this.modelId;

    // Honest grounding note from the counts object (optional-chain + default).
    const nWindows = Number(body.evidence?.log_windows) || 0;
    const nAlerts = Number(body.evidence?.alerts) || 0;
    const note =
      `Live Urbani chat (Amazon Bedrock Nova 2 Lite) — grounded server-side in ` +
      `${nWindows} recent log window(s) and ${nAlerts} alert(s).`;

    // Token counts are not returned by QA; estimate for usage/audit.
    const inputTokens = Math.min(Math.ceil(input.question.length / 4), 1500);
    const outputTokens = Math.ceil(answer.length / 4);

    return {
      answer, // markdown, preserved verbatim (rendered client-side)
      citations: [], // QA returns counts, not lines — never fabricate citations
      modelId,
      provider: this.name,
      inputTokens,
      outputTokens,
      guardrailIntervened: false,
      meta: { source: 'LIVE', note },
    };
  }

  /** First non-empty answer string among the primary + defensive alias fields. */
  private resolveAnswer(body: UrbaniChatResponse): string | undefined {
    const candidates = [body.answer, body.response, body.message, body.text, body.content];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    return undefined;
  }
}
