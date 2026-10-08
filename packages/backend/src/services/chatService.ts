import type { Sourced } from '@urbani/shared';
import { config } from '../config';
import { getIntegrations } from '../integrations';
import type { ChatTurn } from '../integrations/ai/AIProvider';
import { aiRepository } from '../repositories/aiRepository';
import { auditRepository } from '../repositories/auditRepository';
import { ServiceUnavailableError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Chat service (AI Log Chatbot).
 *
 * Answers natural-language questions about the logs, grounded in the current
 * log window pulled through the CloudWatch adapter boundary (LIVE when the real
 * Urbani API is wired, MOCK otherwise). The AIProvider abstraction means the
 * exact same flow works with MockAIProvider now and BedrockAIProvider later.
 *
 * Advisory only — the assistant never performs actions.
 */
export interface ChatAnswer {
  answer: string;
  citations: string[];
  provider: string;
  modelId: string;
  service: string;
  environment: string;
  logsSource: string; // LIVE | MOCK | WAITING_FOR_INTEGRATION
  /**
   * Honest one-line grounding note from the provider (e.g. "grounded server-side
   * in N recent log window(s) and M alert(s)"). Clarifies that the answer may
   * draw on ALERTS, not just the filtered log window the Logs page shows.
   */
  groundingNote: string;
  inputTokens: number;
  outputTokens: number;
}

export const chatService = {
  async ask(
    question: string,
    opts: { service?: string; environment?: string; history?: ChatTurn[]; actor: string },
  ): Promise<Sourced<ChatAnswer>> {
    const { cloudwatch, aiProvider } = getIntegrations();
    // Server-side service gating: only an enabled service reaches the live
    // endpoint; disabled/unknown services fall back to the default (main). This
    // owns the "disabled services are never called" invariant.
    const service =
      opts.service && config.urbani.services.includes(opts.service)
        ? opts.service
        : config.urbani.service;
    const environment = opts.environment ?? config.urbani.environment;

    // Ground the answer in the current log window (LIVE if configured). A logs
    // fetch failure (e.g. an expired key -> HTTP 403) must NOT 500 the chat: the
    // live /chat endpoint grounds server-side on its own window anyway, so we
    // degrade to an empty local window and let the provider answer honestly.
    let logsRes: Awaited<ReturnType<typeof cloudwatch.getLogs>>;
    try {
      logsRes = await cloudwatch.getLogs({ service, limit: 100 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn('Chat log-window fetch failed; continuing with an empty window', {
        service,
        message,
      });
      logsRes = { meta: { source: 'WAITING_FOR_INTEGRATION', note: 'Log window unavailable.' }, value: [] };
    }

    let result: Awaited<ReturnType<typeof aiProvider.askLogs>>;
    try {
      result = await aiProvider.askLogs({
        question,
        logs: logsRes.value,
        service,
        environment,
        history: opts.history,
      });
    } catch (e) {
      // Record a safe audit of the failed turn (no secrets, no key).
      auditRepository.record(opts.actor, 'ALERT_VIEWED', 'chat', {
        questionChars: question.length,
        logsSource: logsRes.meta.source,
        outcome: 'unavailable',
      });
      // Wrap anything not already a 503-mapped error so the handler returns a
      // controlled 503 CHAT_UNAVAILABLE — never a 500, never a mock answer, no
      // key leak (AC10). The live provider throws ServiceUnavailableError.
      throw e instanceof ServiceUnavailableError ? e : new ServiceUnavailableError();
    }

    // Record the interaction for usage/audit (question text only; no secrets).
    aiRepository.insert({
      alertId: null,
      timestamp: new Date().toISOString(),
      service,
      environment,
      modelId: result.modelId,
      provider: `${result.provider}:chat`,
      anomalyType: null,
      confidence: null,
      finding: null,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      dataSource: result.meta.source,
    });
    auditRepository.record(opts.actor, 'ALERT_VIEWED', 'chat', {
      // Safe metadata only — never log secrets/PII.
      questionChars: question.length,
      logsSource: logsRes.meta.source,
    });

    return {
      source: result.meta.source,
      sourceNote: result.meta.note,
      data: {
        answer: result.answer,
        citations: result.citations,
        provider: result.provider,
        modelId: result.modelId,
        service,
        environment,
        logsSource: logsRes.meta.source,
        groundingNote: result.meta.note ?? '',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    };
  },
};
