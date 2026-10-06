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

  /** Grounding window (minutes) sent to AWS /chat so it matches the Logs page. */
  private readonly windowMinutes: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly service: string,
    modelId: string,
    private readonly timeoutMs: number,
    windowMinutes = 0,
  ) {
    this.modelId = modelId;
    this.fallback = new MockAIProvider(modelId);
    this.windowMinutes = Math.max(windowMinutes, 0);
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
   * its own Bedrock log window; by default that is the last 60 minutes, which is
   * usually empty when the app is idle and mismatches the Logs page (24h). We
   * therefore send `minutes` so the chatbot grounds on the SAME window the Logs
   * page shows. On any failure we fall back to Mock so the chat never 500s.
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
        body: JSON.stringify({
          service: this.service,
          question: input.question,
          // Match the Logs-page window so dashboard + chatbot agree. The AWS
          // endpoint accepts `minutes`; when 0/unset it defaults to 60 min.
          ...(this.windowMinutes > 0 ? { minutes: this.windowMinutes } : {}),
        }),
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

    // evidence[] -> citations (string[]). NEVER synthesize entries. Each item
    // may be a nested JSON string (same shape as the logs API); unwrap it to the
    // human-readable message so citations are clean, not raw JSON blobs.
    const citations = Array.isArray(body.evidence)
      ? body.evidence.map((e) => this.cleanEvidence(String(e)))
      : [];

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

  /**
   * An evidence string may be a nested JSON log event, e.g.
   * {"level":"ERROR","message":"DatabaseConnectionTimeout ...","error_code":"..."}.
   * Extract a clean, human-readable citation. If it is not JSON, return as-is.
   */
  private cleanEvidence(s: string): string {
    const t = s.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return s;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const level = typeof o.level === 'string' ? o.level : undefined;
      const msg = typeof o.message === 'string' ? o.message : undefined;
      if (msg) return level ? `${level}: ${msg}` : msg;
      return s;
    } catch {
      return s;
    }
  }
}
