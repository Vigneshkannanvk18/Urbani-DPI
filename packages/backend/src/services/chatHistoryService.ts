import type { ChatRating } from '@urbani/shared';
import { config } from '../config';
import { AppError, NotFoundError } from '../lib/errors';
import { logger } from '../lib/logger';
import { redactText } from '../lib/auditMetadata';
import { getRepositories } from '../repositories';
import type { ChatFeedback, ChatMessage, ChatSession } from '../repositories/types';
import { fromPublicMessageId, toPublicMessageId } from './chatService';

/**
 * Chat history, feedback and quality summary (DPI 2 items 8-9).
 *
 * PRIVACY: every read/write of conversation content is scoped to the owner (req.auth.sub). A session that
 * belongs to someone else is reported as 404, exactly like a missing one. No role (Super Admin included) can
 * read another user's content. The quality summary exposes only aggregates and de-identified DOWN comments.
 */
export type ApiRating = 'UP' | 'DOWN';
const toApi = (r: ChatRating): ApiRating => (r === 'LIKE' ? 'UP' : 'DOWN');
const toStored = (r: ApiRating): ChatRating => (r === 'UP' ? 'LIKE' : 'DISLIKE');

const historyDisabled = () =>
  new AppError('CHAT_HISTORY_DISABLED', 'Chat history is disabled (CHAT_HISTORY_ENABLED=false); nothing is stored.', 409);

export function sessionDto(s: ChatSession) {
  return {
    id: s.id,
    title: s.title,
    service: s.service,
    environment: s.environment,
    messageCount: s.messageCount,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function messageDto(m: ChatMessage, fb: ChatFeedback | undefined) {
  return {
    id: toPublicMessageId(m.sessionId, m.id),
    role: m.role,
    content: m.content,
    citations: m.citations,
    provider: m.provider,
    modelId: m.modelId,
    source: m.source,
    logsSource: m.meta?.logsSource ?? null,
    groundingNote: m.meta?.groundingNote ?? null,
    isError: m.meta?.error === true,
    latencyMs:
      m.latencyMs === null || m.latencyMs === undefined
        ? null
        : { totalMs: m.latencyMs, providerMs: m.meta?.providerMs ?? null },
    createdAt: m.createdAt,
    feedback: fb ? { rating: toApi(fb.rating), comment: fb.comment } : null,
  };
}

async function ownedSession(userId: string, sessionId: string): Promise<ChatSession> {
  const s = await getRepositories().chat.getSession(sessionId);
  if (!s || s.userId !== userId) throw new NotFoundError('Chat session not found');
  return s;
}

/** Nearest-rank percentile of an unsorted list; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}
const r1 = (n: number): number => Math.round(n * 10) / 10;
const latencyStats = (values: number[]) => ({
  count: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  max: values.length ? Math.max(...values) : null,
});

export const chatHistoryService = {
  async listSessions(userId: string, opts: { limit?: number; cursor?: string }) {
    if (!config.chat.historyEnabled) return { items: [], nextCursor: null, historyEnabled: false };
    const page = await getRepositories().chat.listSessionsByUser(userId, opts);
    return { items: page.items.map(sessionDto), nextCursor: page.nextCursor, historyEnabled: true };
  },

  async getSession(userId: string, sessionId: string) {
    if (!config.chat.historyEnabled) throw historyDisabled();
    const session = await ownedSession(userId, sessionId);
    const chat = getRepositories().chat;
    const messages: ChatMessage[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await chat.listMessages(session.id, { limit: 500, cursor });
      messages.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const fb = new Map((await chat.listFeedback(session.id)).map((f) => [f.messageId, f]));
    return { session: sessionDto(session), messages: messages.map((m) => messageDto(m, fb.get(m.id))) };
  },

  async rename(userId: string, sessionId: string, title: string) {
    if (!config.chat.historyEnabled) throw historyDisabled();
    await ownedSession(userId, sessionId);
    const s = await getRepositories().chat.renameSession(sessionId, title);
    if (!s) throw new NotFoundError('Chat session not found');
    return sessionDto(s);
  },

  /** Hard delete of the session, its messages and feedback. */
  async remove(userId: string, sessionId: string): Promise<{ messageCount: number }> {
    if (!config.chat.historyEnabled) throw historyDisabled();
    const s = await ownedSession(userId, sessionId);
    await getRepositories().chat.deleteSession(s.id);
    return { messageCount: s.messageCount };
  },

  /** rating null clears. Idempotent upsert; only assistant messages inside the caller's own sessions. */
  async setFeedback(userId: string, publicMessageId: string, rating: ApiRating | null, comment?: string) {
    if (!config.chat.historyEnabled) throw historyDisabled();
    const ref = fromPublicMessageId(publicMessageId);
    if (!ref) throw new NotFoundError('Message not found');
    await ownedSession(userId, ref.sessionId);
    const chat = getRepositories().chat;
    let found: ChatMessage | undefined;
    let cursor: string | undefined;
    for (let i = 0; i < 10 && !found; i++) {
      const page = await chat.listMessages(ref.sessionId, { limit: 500, cursor });
      found = page.items.find((m) => m.id === ref.messageId);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (!found || found.role !== 'assistant' || found.meta?.error) throw new NotFoundError('Message not found');
    if (rating === null) {
      await chat.deleteFeedback(ref.sessionId, ref.messageId);
      return { messageId: publicMessageId, rating: null, comment: null };
    }
    const cleaned = comment?.trim() ? redactText(comment.trim()) : null;
    const fb = await chat.setFeedback({
      sessionId: ref.sessionId,
      messageId: ref.messageId,
      userId,
      rating: toStored(rating),
      comment: cleaned,
    });
    return { messageId: publicMessageId, rating: toApi(fb.rating), comment: fb.comment };
  },

  /** Quality summary: aggregates only, no user identity and no question text. */
  async summary(from: Date, to: Date) {
    const chat = getRepositories().chat;
    const f = from.toISOString();
    const t = to.toISOString();
    const [feedback, latency] = await Promise.all([chat.listFeedbackRecords(f, t), chat.listLatencySamples(f, t)]);
    const up = feedback.filter((x) => x.rating === 'LIKE').length;
    const down = feedback.length - up;
    const perDay = new Map<string, { up: number; down: number }>();
    const perService = new Map<string, { up: number; down: number }>();
    for (const x of feedback) {
      const day = x.updatedAt.slice(0, 10);
      const svc = x.service ?? 'unknown';
      for (const [map, key] of [[perDay, day], [perService, svc]] as const) {
        const cur = map.get(key) ?? { up: 0, down: 0 };
        if (x.rating === 'LIKE') cur.up++;
        else cur.down++;
        map.set(key, cur);
      }
    }
    const total = feedback.length;
    return {
      range: { from: f, to: t },
      historyEnabled: config.chat.historyEnabled,
      feedback: {
        total,
        up,
        down,
        satisfactionPct: total ? r1((up / total) * 100) : null,
        perDay: [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => ({ date, ...v })),
        perService: [...perService.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([service, v]) => ({ service, ...v })),
      },
      latency: {
        totalMs: latencyStats(latency.map((x) => x.totalMs)),
        providerMs: latencyStats(latency.flatMap((x) => (x.providerMs === null ? [] : [x.providerMs]))),
        note: 'End-to-end per answer: includes the Urbani /chat round trip, not just the model.',
      },
      // De-identified: message id, service, comment, timestamp only.
      recentDownComments: feedback
        .filter((x) => x.rating === 'DISLIKE' && x.comment)
        .slice(0, 10)
        .map((x) => ({ messageId: x.messageId, service: x.service, comment: x.comment, timestamp: x.updatedAt })),
    };
  },

  /** Retention: deletes idle conversations older than the window; ONE summary audit event. No-op when 0 or disabled. */
  async purgeExpired(now: Date = new Date(), days = config.chat.retentionDays) {
    if (days <= 0 || !config.chat.historyEnabled) return null;
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const repos = getRepositories();
    const purged = await repos.chat.purgeOlderThan(cutoff);
    await repos.audit.record('system', 'chat.purge', undefined, { ...purged, cutoff, retentionDays: days });
    return purged;
  },
};

/** Runs the chat purge once now and then every 24h, under the same AUDIT_RETENTION_JOB switch. */
export function startChatRetentionJob(): () => void {
  if (!config.audit.retentionJobEnabled || !config.chat.historyEnabled || config.chat.retentionDays <= 0) {
    logger.info('Chat retention job not running', {
      enabled: config.audit.retentionJobEnabled,
      historyEnabled: config.chat.historyEnabled,
      retentionDays: config.chat.retentionDays,
    });
    return () => undefined;
  }
  const run = () =>
    chatHistoryService
      .purgeExpired()
      .then((p) => logger.info('Chat retention purge done', { ...p }))
      .catch((err) => logger.warn('Chat retention purge failed', { error: err instanceof Error ? err.message : String(err) }));
  void run();
  const timer = setInterval(run, 24 * 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
