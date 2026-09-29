import type { Sourced } from '@urbani/shared';
import { getIntegrations } from '../integrations';
import type { ChatTurn } from '../integrations/ai/AIProvider';
import { aiRepository } from '../repositories/aiRepository';
import { auditRepository } from '../repositories/auditRepository';

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
  inputTokens: number;
  outputTokens: number;
}

export const chatService = {
  async ask(
    question: string,
    opts: { service?: string; environment?: string; history?: ChatTurn[]; actor: string },
  ): Promise<Sourced<ChatAnswer>> {
    const { cloudwatch, aiProvider } = getIntegrations();
    const service = opts.service ?? 'urbani-app';
    const environment = opts.environment ?? 'production-eb';

    // Ground the answer in the current log window (LIVE if configured).
    const logsRes = await cloudwatch.getLogs({ service, limit: 100 });

    const result = await aiProvider.askLogs({
      question,
      logs: logsRes.value,
      service,
      environment,
      history: opts.history,
    });

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
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    };
  },
};
