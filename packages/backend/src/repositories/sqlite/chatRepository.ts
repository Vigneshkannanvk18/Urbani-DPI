import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChatMessageRole, ChatRating, DataSource } from '@urbani/shared';
import { getDb } from '../../db/connection';
import { PersistenceError } from '../../lib/errors';
import { decodeCursor, encodeCursor, newTimeOrderedId } from '../common';
import {
  clampMessageLimit,
  clampSessionLimit,
  messageCursorSchema,
  parseChatFeedbackInput,
  parseNewChatMessage,
  parseNewChatSession,
  parseReadId,
  parseSessionTitle,
  sessionCursorSchema,
} from '../validation';
import type {
  ChatFeedback,
  ChatFeedbackInput,
  ChatMessage,
  ChatMessageMeta,
  ChatFeedbackRecord,
  ChatLatencySample,
  ChatPurgeResult,
  ChatRepository,
  ChatSession,
  CursorOptions,
  CursorPage,
  NewChatMessage,
  NewChatSession,
} from '../types';
import type { SqliteContext } from './index';

/**
 * Chat sessions, messages and feedback (DPI 2 item 1), SQLite driver. Every write
 * validates first (validation.ts), then runs its checks and writes in one synchronous
 * transaction. Lists use keyset pages: sessions by (updated_at DESC, id DESC),
 * messages by id ASC (ids are time-ordered), feedback by message_id.
 */

interface SessionRow {
  id: string;
  user_id: string;
  title: string | null;
  service: string | null;
  environment: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  citations_json: string;
  provider: string | null;
  model_id: string | null;
  data_source: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  meta_json: string | null;
}

interface FeedbackRow {
  message_id: string;
  session_id: string;
  user_id: string;
  rating: string;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

function db(): Database.Database {
  return getDb();
}

const notFound = () => new PersistenceError('REFERENCE_NOT_FOUND', 'Referenced record not found');

/** A user exists when a users row with that id exists, whatever is_active is. */
function userExists(userId: string): boolean {
  return Boolean(db().prepare('SELECT 1 FROM users WHERE id = ?').get(userId));
}

function rowToSession(r: SessionRow): ChatSession {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    service: r.service,
    environment: r.environment,
    messageCount: r.message_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as ChatMessageRole,
    content: r.content,
    citations: JSON.parse(r.citations_json) as string[],
    provider: r.provider,
    modelId: r.model_id,
    source: r.data_source as DataSource | null,
    latencyMs: r.latency_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    createdAt: r.created_at,
    meta: r.meta_json ? (JSON.parse(r.meta_json) as ChatMessageMeta) : null,
  };
}

function rowToFeedback(r: FeedbackRow): ChatFeedback {
  return {
    messageId: r.message_id,
    sessionId: r.session_id,
    userId: r.user_id,
    rating: r.rating as ChatRating,
    comment: r.comment,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function sqliteChatRepository(ctx: SqliteContext): ChatRepository {
  async function createSession(input: NewChatSession): Promise<ChatSession> {
    const s = parseNewChatSession(input);
    const now = ctx.now();
    const row: SessionRow = {
      id: s.id ?? randomUUID(),
      user_id: s.userId,
      title: s.title,
      service: s.service,
      environment: s.environment,
      message_count: 0,
      created_at: now,
      updated_at: now,
    };
    const tx = db().transaction(() => {
      if (!userExists(row.user_id)) throw notFound();
      if (db().prepare('SELECT 1 FROM chat_sessions WHERE id = ?').get(row.id)) {
        throw new PersistenceError('DUPLICATE', 'Record already exists');
      }
      db()
        .prepare(
          `INSERT INTO chat_sessions (id, user_id, title, service, environment, message_count, created_at, updated_at)
           VALUES (@id, @user_id, @title, @service, @environment, @message_count, @created_at, @updated_at)`,
        )
        .run(row);
    });
    tx();
    return rowToSession(row);
  }

  async function getSession(sessionId: string): Promise<ChatSession | null> {
    const id = parseReadId(sessionId);
    const row = db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async function listSessionsByUser(userId: string, opts: CursorOptions = {}): Promise<CursorPage<ChatSession>> {
    const uid = parseReadId(userId);
    const limit = clampSessionLimit(opts.limit);
    const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor, sessionCursorSchema);
    const rows = db()
      .prepare(
        `SELECT * FROM chat_sessions
          WHERE user_id = @uid
            ${after ? 'AND (updated_at < @cu OR (updated_at = @cu AND id < @cid))' : ''}
          ORDER BY updated_at DESC, id DESC
          LIMIT @limit + 1`,
      )
      .all({ uid, limit, ...(after ? { cu: after[0], cid: after[1] } : {}) }) as SessionRow[];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(rowToSession),
      nextCursor: more && last ? encodeCursor([last.updated_at, last.id]) : null,
    };
  }

  async function appendMessage(input: NewChatMessage): Promise<ChatMessage> {
    const m = parseNewChatMessage(input);
    const now = ctx.now();
    const row: MessageRow = {
      id: newTimeOrderedId(now),
      session_id: m.sessionId,
      role: m.role,
      content: m.content,
      citations_json: JSON.stringify(m.citations),
      provider: m.provider,
      model_id: m.modelId,
      data_source: m.source,
      latency_ms: m.latencyMs,
      input_tokens: m.inputTokens,
      output_tokens: m.outputTokens,
      created_at: now,
      meta_json: m.meta ? JSON.stringify(m.meta) : null,
    };
    const tx = db().transaction(() => {
      if (!db().prepare('SELECT 1 FROM chat_sessions WHERE id = ?').get(row.session_id)) throw notFound();
      db()
        .prepare(
          `INSERT INTO chat_messages
           (id, session_id, role, content, citations_json, provider, model_id, data_source,
            latency_ms, input_tokens, output_tokens, created_at, meta_json)
           VALUES (@id, @session_id, @role, @content, @citations_json, @provider, @model_id, @data_source,
                   @latency_ms, @input_tokens, @output_tokens, @created_at, @meta_json)`,
        )
        .run(row);
      db()
        .prepare('UPDATE chat_sessions SET updated_at = @now, message_count = message_count + 1 WHERE id = @sessionId')
        .run({ now, sessionId: row.session_id });
    });
    tx();
    return rowToMessage(row);
  }

  async function listMessages(sessionId: string, opts: CursorOptions = {}): Promise<CursorPage<ChatMessage>> {
    const sid = parseReadId(sessionId);
    const limit = clampMessageLimit(opts.limit);
    const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor, messageCursorSchema);
    const rows = db()
      .prepare(
        `SELECT * FROM chat_messages
          WHERE session_id = @sid ${after ? 'AND id > @cid' : ''}
          ORDER BY id ASC
          LIMIT @limit + 1`,
      )
      .all({ sid, limit, ...(after ? { cid: after[0] } : {}) }) as MessageRow[];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(rowToMessage),
      nextCursor: more && last ? encodeCursor([last.id]) : null,
    };
  }

  /** One feedback per message: create, or update rating/comment/user and keep createdAt. */
  async function setFeedback(input: ChatFeedbackInput): Promise<ChatFeedback> {
    const f = parseChatFeedbackInput(input);
    const now = ctx.now();
    const tx = db().transaction((): FeedbackRow => {
      if (!db().prepare('SELECT 1 FROM chat_messages WHERE id = ? AND session_id = ?').get(f.messageId, f.sessionId)) {
        throw notFound();
      }
      if (!userExists(f.userId)) throw notFound();
      db()
        .prepare(
          `INSERT INTO chat_feedback (message_id, session_id, user_id, rating, comment, created_at, updated_at)
           VALUES (@message_id, @session_id, @user_id, @rating, @comment, @now, @now)
           ON CONFLICT(message_id) DO UPDATE SET
             rating = excluded.rating, comment = excluded.comment, user_id = excluded.user_id,
             updated_at = excluded.updated_at`,
        )
        .run({
          message_id: f.messageId,
          session_id: f.sessionId,
          user_id: f.userId,
          rating: f.rating,
          comment: f.comment,
          now,
        });
      return db().prepare('SELECT * FROM chat_feedback WHERE message_id = ?').get(f.messageId) as FeedbackRow;
    });
    return rowToFeedback(tx());
  }

  async function listFeedback(sessionId: string): Promise<ChatFeedback[]> {
    const sid = parseReadId(sessionId);
    const rows = db()
      .prepare('SELECT * FROM chat_feedback WHERE session_id = ? ORDER BY message_id')
      .all(sid) as FeedbackRow[];
    return rows.map(rowToFeedback);
  }

  async function renameSession(sessionId: string, title: string): Promise<ChatSession | null> {
    const id = parseReadId(sessionId);
    const t = parseSessionTitle(title);
    db().prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(t, id);
    return getSession(id);
  }

  /** Explicit deletes (feedback, messages, session) in one transaction; does not rely on FK cascades. */
  function deleteSessionTx(id: string): { messages: number; feedback: number; session: number } {
    const feedback = db().prepare('DELETE FROM chat_feedback WHERE session_id = ?').run(id).changes;
    const messages = db().prepare('DELETE FROM chat_messages WHERE session_id = ?').run(id).changes;
    const session = db().prepare('DELETE FROM chat_sessions WHERE id = ?').run(id).changes;
    return { messages, feedback, session };
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    const id = parseReadId(sessionId);
    return db().transaction(() => deleteSessionTx(id).session > 0)();
  }

  async function deleteFeedback(sessionId: string, messageId: string): Promise<boolean> {
    const sid = parseReadId(sessionId);
    const mid = parseReadId(messageId);
    return db().prepare('DELETE FROM chat_feedback WHERE session_id = ? AND message_id = ?').run(sid, mid).changes > 0;
  }

  async function listFeedbackRecords(from: string, to: string): Promise<ChatFeedbackRecord[]> {
    const rows = db()
      .prepare(
        `SELECT f.message_id, f.session_id, f.rating, f.comment, f.updated_at, s.service
           FROM chat_feedback f LEFT JOIN chat_sessions s ON s.id = f.session_id
          WHERE f.updated_at >= ? AND f.updated_at <= ?
          ORDER BY f.updated_at DESC, f.message_id DESC LIMIT 20000`,
      )
      .all(from, to) as Array<{
      message_id: string; session_id: string; rating: string; comment: string | null; updated_at: string; service: string | null;
    }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      sessionId: r.session_id,
      rating: r.rating as ChatRating,
      comment: r.comment,
      updatedAt: r.updated_at,
      service: r.service,
    }));
  }

  async function listLatencySamples(from: string, to: string): Promise<ChatLatencySample[]> {
    const rows = db()
      .prepare(
        `SELECT m.created_at, m.latency_ms, m.meta_json, s.service
           FROM chat_messages m LEFT JOIN chat_sessions s ON s.id = m.session_id
          WHERE m.role = 'assistant' AND m.latency_ms IS NOT NULL AND m.created_at >= ? AND m.created_at <= ?
          ORDER BY m.created_at DESC LIMIT 20000`,
      )
      .all(from, to) as Array<{ created_at: string; latency_ms: number; meta_json: string | null; service: string | null }>;
    return rows
      .map((r) => ({ r, meta: r.meta_json ? (JSON.parse(r.meta_json) as ChatMessageMeta) : null }))
      .filter(({ meta }) => !meta?.error)
      .map(({ r, meta }) => ({
        createdAt: r.created_at,
        service: r.service,
        totalMs: r.latency_ms,
        providerMs: meta?.providerMs ?? null,
      }));
  }

  async function purgeOlderThan(cutoff: string): Promise<ChatPurgeResult> {
    return db().transaction(() => {
      const ids = (db().prepare('SELECT id FROM chat_sessions WHERE updated_at < ?').all(cutoff) as { id: string }[]).map((r) => r.id);
      const out: ChatPurgeResult = { sessions: 0, messages: 0, feedback: 0 };
      for (const id of ids) {
        const d = deleteSessionTx(id);
        out.sessions += d.session;
        out.messages += d.messages;
        out.feedback += d.feedback;
      }
      return out;
    })();
  }

  return {
    createSession, getSession, listSessionsByUser, appendMessage, listMessages, setFeedback, listFeedback,
    renameSession, deleteSession, deleteFeedback, listFeedbackRecords, listLatencySamples, purgeOlderThan,
  };
}
