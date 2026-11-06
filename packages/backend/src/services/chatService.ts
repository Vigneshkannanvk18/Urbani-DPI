import type { Sourced } from '@urbani/shared';
import { performance } from 'node:perf_hooks';
import { config } from '../config';
import { getIntegrations } from '../integrations';
import type { ChatTurn } from '../integrations/ai/AIProvider';
import { getRepositories } from '../repositories';
import { NotFoundError, ServiceUnavailableError } from '../lib/errors';
import { logger } from '../lib/logger';
import { preview } from '../lib/auditMetadata';

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
  sessionId: string | null;
  assistantMessageId: string | null;
  historyEnabled: boolean;
  latencyMs: { totalMs: number; providerMs: number };
}

export const SESSION_TITLE_MAX = 60;
const FAILED_TURN_TEXT = 'Urbani Copilot was unavailable for this question.';

/** Public message id: carries the session so DynamoDB can address the item (no GSI on message id). */
export const toPublicMessageId = (sessionId: string, messageId: string): string => `${sessionId}~${messageId}`;
export function fromPublicMessageId(id: string): { sessionId: string; messageId: string } | null {
  const i = id.indexOf('~');
  return i > 0 && i < id.length - 1 ? { sessionId: id.slice(0, i), messageId: id.slice(i + 1) } : null;
}

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

export const chatService = {
  async ask(
    question: string,
    opts: {
      service?: string;
      environment?: string;
      history?: ChatTurn[];
      actor: string;
      /** Owner of the conversation; required for persistence. */
      userId?: string;
      sessionId?: string;
      /** performance.now() captured when the request was received (defaults to now). */
      startedAt?: number;
    },
  ): Promise<Sourced<ChatAnswer>> {
    const t0 = opts.startedAt ?? performance.now();
    const { cloudwatch, aiProvider } = getIntegrations();
    const repos = getRepositories();
    const historyEnabled = config.chat.historyEnabled && Boolean(opts.userId);
    // Server-side service gating: only an enabled service reaches the live
    // endpoint; disabled/unknown services fall back to the default (main). This
    // owns the "disabled services are never called" invariant.
    const service =
      opts.service && config.urbani.services.includes(opts.service)
        ? opts.service
        : config.urbani.service;
    const environment = opts.environment ?? config.urbani.environment;

    // Resolve the conversation first so a foreign/unknown sessionId fails with 404 BEFORE a billed /chat call.
    let sessionId: string | null = null;
    if (historyEnabled && opts.sessionId) {
      const existing = await repos.chat.getSession(opts.sessionId);
      if (!existing || existing.userId !== opts.userId) throw new NotFoundError('Chat session not found');
      sessionId = existing.id;
    }
    // Persistence is best effort: a storage problem must not take the chat down.
    const persist = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        logger.warn('Chat history write failed; continuing without it', {
          label,
          message: err instanceof Error ? err.message : 'unknown error',
        });
        return null;
      }
    };
    if (historyEnabled) {
      if (!sessionId) {
        const title = question.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX);
        const created = await persist('createSession', () =>
          repos.chat.createSession({ userId: opts.userId!, title, service, environment }),
        );
        sessionId = created?.id ?? null;
      }
      if (sessionId) {
        const sid = sessionId;
        await persist('userMessage', () => repos.chat.appendMessage({ sessionId: sid, role: 'user', content: question }));
      }
    }

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

    const tProviderStart = performance.now();
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
      const tEnd = performance.now();
      const latency = {
        totalMs: round1(tEnd - t0),
        providerMs: round1(tEnd - tProviderStart),
        preparationMs: round1(tProviderStart - t0),
      };
      logger.info('chat.latency', { outcome: 'unavailable', service, ...latency });
      if (sessionId) {
        const sid = sessionId;
        await persist('errorMessage', () =>
          repos.chat.appendMessage({
            sessionId: sid,
            role: 'assistant',
            content: FAILED_TURN_TEXT,
            latencyMs: Math.round(latency.totalMs),
            meta: { error: true, providerMs: latency.providerMs, preparationMs: latency.preparationMs, logsSource: logsRes.meta.source },
          }),
        );
      }
      // Record a safe audit of the failed turn (no secrets, no key).
      await repos.audit.record(
        opts.actor,
        'chat.query',
        'chat',
        {
          service,
          questionPreview: preview(question),
          questionChars: question.length,
          logsSource: logsRes.meta.source,
          outcome: 'unavailable',
          latency,
          ...(sessionId ? { sessionId } : {}),
        },
        'FAILURE',
      );
      // Wrap anything not already a 503-mapped error so the handler returns a
      // controlled 503 CHAT_UNAVAILABLE — never a 500, never a mock answer, no
      // key leak (AC10). The live provider throws ServiceUnavailableError.
      const details = sessionId ? { sessionId, latencyMs: { totalMs: latency.totalMs, providerMs: latency.providerMs } } : undefined;
      throw new ServiceUnavailableError(e instanceof ServiceUnavailableError ? e.message : undefined, details);
    }
    const tEnd = performance.now();
    const latency = {
      totalMs: round1(tEnd - t0),
      providerMs: round1(tEnd - tProviderStart),
      preparationMs: round1(tProviderStart - t0),
    };
    logger.info('chat.latency', { outcome: 'ok', service, provider: result.provider, ...latency });

    // Record the interaction for usage/audit (question text only; no secrets).
    await repos.aiAnalyses.insert({
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
    await repos.audit.record(opts.actor, 'chat.query', 'chat', {
      service,
      questionPreview: preview(question),
      // Safe metadata only — never log secrets/PII, never the answer.
      questionChars: question.length,
      logsSource: logsRes.meta.source,
      latency,
      ...(sessionId ? { sessionId } : {}),
    });

    let assistantMessageId: string | null = null;
    if (sessionId) {
      const sid = sessionId;
      const saved = await persist('assistantMessage', () =>
        repos.chat.appendMessage({
          sessionId: sid,
          role: 'assistant',
          content: result.answer,
          citations: result.citations,
          provider: result.provider,
          modelId: result.modelId,
          source: result.meta.source,
          latencyMs: Math.round(latency.totalMs),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          meta: {
            groundingNote: result.meta.note ?? '',
            logsSource: logsRes.meta.source,
            providerMs: latency.providerMs,
            preparationMs: latency.preparationMs,
          },
        }),
      );
      assistantMessageId = saved ? toPublicMessageId(sid, saved.id) : null;
    }

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
        sessionId: assistantMessageId ? sessionId : null,
        assistantMessageId,
        historyEnabled: config.chat.historyEnabled,
        latencyMs: { totalMs: latency.totalMs, providerMs: latency.providerMs },
      },
    };
  },
};