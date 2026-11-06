import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { performance } from 'node:perf_hooks';
import type { UserRole } from '@urbani/shared';
import { createApp } from '../app';
import { config } from '../config';
import { seed } from '../db/seed';
import { freshTestDb } from '../test/testDb';
import { getRepositories } from '../repositories';
import { authService } from '../services/authService';
import { chatHistoryService, percentile } from '../services/chatHistoryService';
import { resetIntegrations, setIntegrationsForTesting } from '../integrations';
import type { AIProvider, AskLogsResult } from '../integrations/ai/AIProvider';
import type { CloudWatchAdapter } from '../integrations/types';
import { ServiceUnavailableError } from '../lib/errors';
import { redactText } from '../lib/auditMetadata';

/** Chat history, feedback, quality summary and latency (DPI 2 items 8-9). */
const PASSWORD = 'Str0ng-Passw0rd!';
const SECRET_ANSWER = 'ANSWER-TEXT-MUST-NOT-BE-AUDITED';
const app = createApp();
let db: ReturnType<typeof freshTestDb>;
const tokens = {} as Record<string, string>;
const ids = {} as Record<string, string>;

const behavior = { delayMs: 0, fail: false };
const fakeProvider = {
  name: 'FakeProvider',
  modelId: 'fake-model',
  async askLogs(): Promise<AskLogsResult> {
    if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
    if (behavior.fail) throw new ServiceUnavailableError();
    return {
      answer: SECRET_ANSWER,
      citations: ['line 1'],
      modelId: 'fake-model',
      provider: 'FakeProvider',
      inputTokens: 5,
      outputTokens: 7,
      guardrailIntervened: false,
      meta: { source: 'MOCK', note: 'grounded in 1 window' },
    };
  },
  async analyzeTelemetry() {
    throw new Error('not used');
  },
} as unknown as AIProvider;
const fakeCloudwatch = {
  kind: 'CLOUDWATCH',
  async getLogs() {
    return { meta: { source: 'MOCK', note: 'window' }, value: [] };
  },
  async getMetrics() {
    return { meta: { source: 'MOCK' }, value: [] };
  },
} as unknown as CloudWatchAdapter;

const call = (method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string, token?: string, body?: object) => {
  const r = request(app)[method](path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const ask = (token: string, body: object) => call('post', '/api/chat', token, { question: 'Why is main failing?', ...body });
const historyEnabled = (v: boolean) => {
  (config.chat as { historyEnabled: boolean }).historyEnabled = v;
};
const auditOf = async (action: string) =>
  (await getRepositories().audit.listByTimeRange({ actions: [action], limit: 200 })).items;

async function makeUser(email: string, role: UserRole) {
  const res = await call('post', '/api/users', tokens.SUPER_ADMIN, { email, displayName: email, role, password: PASSWORD });
  expect(res.status).toBe(201);
  ids[email] = res.body.data.id;
  tokens[email] = (await authService.login(email, PASSWORD)).token;
}

beforeAll(async () => {
  db = freshTestDb();
  await seed();
  const admin = await authService.login(config.auth.seedAdminEmail, config.auth.seedAdminPassword);
  tokens.SUPER_ADMIN = admin.token;
  ids.SUPER_ADMIN = admin.user.id;
  await makeUser('qa-a@urbani.test', 'QA_OPERATOR');
  await makeUser('qa-b@urbani.test', 'QA_OPERATOR');
  await makeUser('auditor@urbani.test', 'READER_AUDITOR');
  await makeUser('infra@urbani.test', 'INFRA_ADMIN');
  setIntegrationsForTesting({ aiProvider: fakeProvider, cloudwatch: fakeCloudwatch });
});
afterEach(() => {
  historyEnabled(true);
  behavior.delayMs = 0;
  behavior.fail = false;
});
afterAll(() => {
  resetIntegrations();
  db.close();
});
const A = 'qa-a@urbani.test';
const B = 'qa-b@urbani.test';

describe('persistence', () => {
  it('creates a session on the first question and resumes it with sessionId', async () => {
    const first = await ask(tokens[A], { service: 'main', environment: 'qa', question: 'First question about the main service failing repeatedly in QA ' + 'x'.repeat(80) });
    expect(first.status).toBe(200);
    const sid = first.body.data.sessionId as string;
    expect(sid).toBeTruthy();
    expect(first.body.data.assistantMessageId).toContain(sid);
    expect(first.body.data.historyEnabled).toBe(true);
    const second = await ask(tokens[A], { sessionId: sid, question: 'And now?' });
    expect(second.status).toBe(200);
    expect(second.body.data.sessionId).toBe(sid);

    const detail = await call('get', `/api/chat/sessions/${sid}`, tokens[A]);
    expect(detail.status).toBe(200);
    const { session, messages } = detail.body.data;
    expect(session.title).toHaveLength(60);
    expect(session.service).toBe('main');
    expect(session.messageCount).toBe(4);
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[1]).toMatchObject({
      content: SECRET_ANSWER,
      provider: 'FakeProvider',
      modelId: 'fake-model',
      logsSource: 'MOCK',
      groundingNote: 'grounded in 1 window',
      citations: ['line 1'],
      isError: false,
      feedback: null,
    });
    expect(messages[1].latencyMs.totalMs).toBeGreaterThanOrEqual(0);

    const list = await call('get', '/api/chat/sessions', tokens[A]);
    expect(list.body.data.items[0]).toMatchObject({ id: sid, messageCount: 4, service: 'main' });
    expect(list.body.data.historyEnabled).toBe(true);
  });

  it('persists a failed provider call coherently (user message + error marker) and returns the session id', async () => {
    behavior.fail = true;
    const res = await ask(tokens[A], { question: 'will fail' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CHAT_UNAVAILABLE');
    const sid = res.body.error.details.sessionId as string;
    expect(res.body.error.details.latencyMs.totalMs).toBeGreaterThanOrEqual(0);
    const { messages } = (await call('get', `/api/chat/sessions/${sid}`, tokens[A])).body.data;
    expect(messages.map((m: { role: string; isError: boolean }) => [m.role, m.isError])).toEqual([['user', false], ['assistant', true]]);
    const failed = (await auditOf('chat.query')).find((e) => e.result === 'FAILURE' && (e.metadata as { sessionId?: string })?.sessionId === sid);
    expect(failed).toBeTruthy();
    expect((failed!.metadata as { latency: { totalMs: number } }).latency.totalMs).toBeGreaterThanOrEqual(0);
    // an error marker cannot be rated
    const fb = await call('put', `/api/chat/messages/${messages[1].id}/feedback`, tokens[A], { rating: 'UP' });
    expect(fb.status).toBe(404);
  });

  it('stores nothing when history is disabled and says so', async () => {
    const before = (await getRepositories().chat.listSessionsByUser(ids[A])).items.length;
    historyEnabled(false);
    const res = await ask(tokens[A], { question: 'not stored' });
    expect(res.status).toBe(200);
    expect(res.body.data.sessionId).toBeNull();
    expect(res.body.data.assistantMessageId).toBeNull();
    expect(res.body.data.historyEnabled).toBe(false);
    expect((await getRepositories().chat.listSessionsByUser(ids[A])).items.length).toBe(before);
    const list = await call('get', '/api/chat/sessions', tokens[A]);
    expect(list.body.data).toMatchObject({ items: [], historyEnabled: false });
    const fb = await call('put', '/api/chat/messages/x~y/feedback', tokens[A], { rating: 'UP' });
    expect(fb.status).toBe(409);
    expect(fb.body.error.code).toBe('CHAT_HISTORY_DISABLED');
  });
});

describe('owner-only isolation', () => {
  it('another user (and Super Admin) gets 404 on read, rename, delete, feedback and resume', async () => {
    const sid = (await ask(tokens[A], { question: 'private question' })).body.data.sessionId as string;
    const msgId = (await call('get', `/api/chat/sessions/${sid}`, tokens[A])).body.data.messages[1].id as string;
    const missing = await call('get', '/api/chat/sessions/does-not-exist', tokens[B]);
    for (const who of [B, 'SUPER_ADMIN']) {
      const get = await call('get', `/api/chat/sessions/${sid}`, tokens[who]);
      expect(get.status, who).toBe(404);
      expect(get.body.error.code).toBe(missing.body.error.code); // existence is not leaked
      expect((await call('patch', `/api/chat/sessions/${sid}`, tokens[who], { title: 'x' })).status).toBe(404);
      expect((await call('delete', `/api/chat/sessions/${sid}`, tokens[who])).status).toBe(404);
      expect((await call('put', `/api/chat/messages/${msgId}/feedback`, tokens[who], { rating: 'UP' })).status).toBe(404);
      expect((await ask(tokens[who], { sessionId: sid })).status).toBe(404);
      const list = await call('get', '/api/chat/sessions', tokens[who]);
      expect(list.body.data.items.map((s: { id: string }) => s.id)).not.toContain(sid);
    }
    // still intact for the owner
    expect((await call('get', `/api/chat/sessions/${sid}`, tokens[A])).body.data.messages).toHaveLength(2);
  });
});

describe('feedback', () => {
  it('upserts, is idempotent, clears, validates and redacts secrets in the comment', async () => {
    const sid = (await ask(tokens[A], { question: 'rate me' })).body.data.sessionId as string;
    const msgs = (await call('get', `/api/chat/sessions/${sid}`, tokens[A])).body.data.messages;
    const url = `/api/chat/messages/${msgs[1].id}/feedback`;
    const up = await call('put', url, tokens[A], { rating: 'UP' });
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ rating: 'UP', comment: null });
    expect((await call('put', url, tokens[A], { rating: 'UP' })).body.data.rating).toBe('UP'); // idempotent
    const down = await call('put', url, tokens[A], { rating: 'DOWN', comment: 'wrong, password=hunter2 and Bearer abcdefghijkl1234' });
    expect(down.body.data.rating).toBe('DOWN');
    expect(down.body.data.comment).not.toContain('hunter2');
    expect(down.body.data.comment).not.toContain('abcdefghijkl1234');
    expect(down.body.data.comment).toContain('[REDACTED]');
    expect(await getRepositories().chat.listFeedback(sid)).toHaveLength(1); // one per user per message
    const shown = (await call('get', `/api/chat/sessions/${sid}`, tokens[A])).body.data.messages[1].feedback;
    expect(shown.rating).toBe('DOWN');

    expect((await call('put', url, tokens[A], { rating: 'MAYBE' })).status).toBe(400);
    expect((await call('put', url, tokens[A], { rating: 'UP', comment: 'x'.repeat(501) })).status).toBe(400);
    expect((await call('put', url, tokens[A], {})).status).toBe(400);
    // only assistant messages
    expect((await call('put', `/api/chat/messages/${msgs[0].id}/feedback`, tokens[A], { rating: 'UP' })).status).toBe(404);
    expect((await call('put', '/api/chat/messages/garbage/feedback', tokens[A], { rating: 'UP' })).status).toBe(404);

    const cleared = await call('put', url, tokens[A], { rating: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.rating).toBeNull();
    expect((await call('put', url, tokens[A], { rating: null })).status).toBe(200); // clearing twice is fine
    expect(await getRepositories().chat.listFeedback(sid)).toEqual([]);
  });

  it('redactText masks key=value secrets, bearer tokens and AWS key ids', () => {
    expect(redactText('api_key: abc123 and AKIAABCDEFGHIJKLMNOP fine')).toBe('api_key=[REDACTED] and [REDACTED] fine');
    expect(redactText('plain feedback')).toBe('plain feedback');
  });
});

describe('delete and retention', () => {
  it('hard-deletes session, messages and feedback and audits chat.session_delete without content', async () => {
    const sid = (await ask(tokens[B], { question: 'to delete' })).body.data.sessionId as string;
    const msgs = (await call('get', `/api/chat/sessions/${sid}`, tokens[B])).body.data.messages;
    await call('put', `/api/chat/messages/${msgs[1].id}/feedback`, tokens[B], { rating: 'UP' });
    const res = await call('delete', `/api/chat/sessions/${sid}`, tokens[B]);
    expect(res.status).toBe(200);
    expect((await call('get', `/api/chat/sessions/${sid}`, tokens[B])).status).toBe(404);
    const chat = getRepositories().chat;
    expect(await chat.getSession(sid)).toBeNull();
    expect((await chat.listMessages(sid)).items).toEqual([]);
    expect(await chat.listFeedback(sid)).toEqual([]);
    const ev = (await auditOf('chat.session_delete'))[0];
    expect(ev.target).toBe(sid);
    expect(JSON.stringify(ev)).not.toContain(SECRET_ANSWER);
    expect(JSON.stringify(ev)).not.toContain('to delete');
  });

  it('renames a session for its owner', async () => {
    const sid = (await ask(tokens[B], { question: 'rename me' })).body.data.sessionId as string;
    const res = await call('patch', `/api/chat/sessions/${sid}`, tokens[B], { title: ' Renamed ' });
    expect(res.body.data.title).toBe('Renamed');
    expect((await call('patch', `/api/chat/sessions/${sid}`, tokens[B], { title: '  ' })).status).toBe(400);
  });

  it('purges idle conversations past the retention window with ONE summary audit event', async () => {
    const old = (await ask(tokens[B], { question: 'old one' })).body.data.sessionId as string;
    const recent = (await ask(tokens[B], { question: 'recent one' })).body.data.sessionId as string;
    const oldDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
    db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(oldDate, old);
    const before = (await auditOf('chat.purge')).length;
    const purged = await chatHistoryService.purgeExpired(new Date(), 90);
    expect(purged).toMatchObject({ messages: 2 });
    expect(purged!.sessions).toBeGreaterThanOrEqual(1);
    expect(await getRepositories().chat.getSession(old)).toBeNull();
    expect(await getRepositories().chat.getSession(recent)).not.toBeNull();
    expect((await auditOf('chat.purge')).length).toBe(before + 1);
    expect(await chatHistoryService.purgeExpired(new Date(), 0)).toBeNull(); // 0 = keep forever
  });
});

describe('quality summary', () => {
  it('computes counts, satisfaction, per-day/per-service series and latency percentiles without identity', async () => {
    db.exec('DELETE FROM chat_feedback; DELETE FROM chat_messages; DELETE FROM chat_sessions;');
    const latencies = [1000, 2000, 3000, 4000, 10000];
    const rated: Array<'UP' | 'DOWN'> = ['UP', 'UP', 'UP', 'DOWN', 'DOWN'];
    for (let i = 0; i < latencies.length; i++) {
      const who = i % 2 ? tokens[B] : tokens[A];
      const r = await ask(who, { question: `Question number ${i} SECRET-QUESTION-TEXT` });
      db.prepare("UPDATE chat_messages SET latency_ms = ? WHERE id = ?").run(latencies[i], r.body.data.assistantMessageId.split('~')[1]);
      await call('put', `/api/chat/messages/${r.body.data.assistantMessageId}/feedback`, who, {
        rating: rated[i],
        comment: rated[i] === 'DOWN' ? `bad answer ${i}` : undefined,
      });
    }
    const res = await call('get', '/api/chat/feedback/summary', tokens['auditor@urbani.test']);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.feedback).toMatchObject({ total: 5, up: 3, down: 2, satisfactionPct: 60 });
    expect(d.feedback.perDay).toEqual([{ date: new Date().toISOString().slice(0, 10), up: 3, down: 2 }]);
    expect(d.feedback.perService).toEqual([{ service: 'main', up: 3, down: 2 }]);
    expect(d.latency.totalMs).toEqual({ count: 5, p50: 3000, p95: 10000, max: 10000 });
    expect(d.latency.providerMs.count).toBe(5);
    expect(d.recentDownComments).toHaveLength(2);
    expect(Object.keys(d.recentDownComments[0]).sort()).toEqual(['comment', 'messageId', 'service', 'timestamp']);
    const text = JSON.stringify(d);
    expect(text).not.toContain('SECRET-QUESTION-TEXT');
    expect(text).not.toContain(ids[A]);
    expect(text).not.toContain(ids[B]);
    expect(text).not.toContain('urbani.test');
    // range filter
    const future = await call('get', `/api/chat/feedback/summary?from=${encodeURIComponent('2999-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2999-02-01T00:00:00.000Z')}`, tokens.SUPER_ADMIN);
    expect(future.body.data.feedback).toMatchObject({ total: 0, satisfactionPct: null });
    expect(future.body.data.latency.totalMs).toMatchObject({ count: 0, p50: null });
    expect((await call('get', '/api/chat/feedback/summary?from=garbage', tokens.SUPER_ADMIN)).status).toBe(400);
  });

  it('percentile uses nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([4, 1, 3, 2], 95)).toBe(4);
  });
});

describe('RBAC for the new routes', () => {
  const routes: Array<{ method: 'get' | 'put' | 'patch' | 'delete'; path: string; body?: object; allowed: string[] }> = [
    { method: 'get', path: '/api/chat/sessions', allowed: ['SUPER_ADMIN', A, 'auditor@urbani.test', 'infra@urbani.test'] },
    { method: 'get', path: '/api/chat/feedback/summary', allowed: ['SUPER_ADMIN', 'auditor@urbani.test', 'infra@urbani.test'] },
  ];
  it('rejects unauthenticated calls with 401', async () => {
    for (const r of [
      ...routes,
      { method: 'get' as const, path: '/api/chat/sessions/x' },
      { method: 'patch' as const, path: '/api/chat/sessions/x', body: { title: 't' } },
      { method: 'delete' as const, path: '/api/chat/sessions/x' },
      { method: 'put' as const, path: '/api/chat/messages/x~y/feedback', body: { rating: 'UP' } },
    ]) {
      expect((await call(r.method, r.path, undefined, r.body)).status, r.path).toBe(401);
    }
  });
  it('chat:use roles use history; only audit:view roles read the summary', async () => {
    for (const r of routes) {
      for (const who of ['SUPER_ADMIN', A, 'auditor@urbani.test', 'infra@urbani.test']) {
        const res = await call(r.method, r.path, tokens[who], r.body);
        expect(res.status, `${who} ${r.path}`).toBe(r.allowed.includes(who) ? 200 : 403);
      }
    }
  });
});

describe('latency (item 9)', () => {
  it('measures end-to-end and provider time with the monotonic clock, stores and audits it (no answer text)', async () => {
    behavior.delayMs = 60;
    const spy = vi.spyOn(performance, 'now');
    const res = await ask(tokens[A], { question: 'how slow are you?' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(res.status).toBe(200);
    const { totalMs, providerMs } = res.body.data.latencyMs;
    expect(providerMs).toBeGreaterThanOrEqual(55);
    expect(totalMs).toBeGreaterThanOrEqual(providerMs);
    expect(totalMs).toBeLessThan(5000);

    const sid = res.body.data.sessionId as string;
    const stored = (await getRepositories().chat.listMessages(sid)).items[1];
    expect(stored.latencyMs).toBe(Math.round(totalMs));
    expect(stored.meta?.providerMs).toBe(providerMs);

    const ev = (await auditOf('chat.query')).find((e) => (e.metadata as { sessionId?: string })?.sessionId === sid)!;
    const latency = (ev.metadata as { latency: Record<string, number> }).latency;
    expect(latency.totalMs).toBe(totalMs);
    expect(latency.providerMs).toBe(providerMs);
    expect(latency.preparationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(ev)).not.toContain(SECRET_ANSWER);
  });

  it('measures the elapsed time from a request-start timestamp passed in (includes pre-handler time)', async () => {
    const { chatService } = await import('../services/chatService');
    const res = await chatService.ask('q', { actor: 'x', userId: ids[A], startedAt: performance.now() - 1000 });
    expect(res.data.latencyMs.totalMs).toBeGreaterThanOrEqual(1000);
    expect(res.data.latencyMs.providerMs).toBeLessThan(500);
  });
});
