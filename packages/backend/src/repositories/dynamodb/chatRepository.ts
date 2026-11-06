import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
  ChatFeedbackRecord,
  ChatLatencySample,
  ChatMessage,
  ChatMessageMeta,
  ChatPurgeResult,
  ChatRepository,
  ChatSession,
  CursorOptions,
  CursorPage,
  NewChatMessage,
  NewChatSession,
} from '../types';
import type { DynamoRepositoryContext } from './index';
import {
  chatMessageItem,
  chatSessionItem,
  itemToChatMessage,
  itemToChatSession,
  itemToFeedback,
  type StoredItem,
} from './items';
import {
  CHAT_FEEDBACK_PREFIX,
  CHAT_MESSAGE_PREFIX,
  CHAT_SESSION_SK,
  chatFeedbackKey,
  chatMessageKey,
  chatPk,
  chatSessionGsi1,
  chatSessionKey,
  chatUserPk,
  userKey,
} from './keys';
import {
  batchGetAll,
  batchWriteAll,
  cancellationCodes,
  CONDITIONAL_CHECK_FAILED,
  errorName,
  isConditionalCheckFailed,
  queryAll,
  queryUpTo,
  send,
  TRANSACTION_CANCELED,
  TRANSACTION_CONFLICT,
  translateAwsError,
  unavailable,
  type QueryInput,
} from './ops';
import { APP_TABLE_GSI1 } from './tableDefinition';

/**
 * Chat sessions, messages and feedback, DynamoDB driver (design §5.3 patterns 39–45). The aggregate lives
 * in one `CHAT#<sessionId>` partition: SESSION, MSG#<messageId> and FEEDBACK#<messageId>. Sessions are also
 * indexed by user on GSI1 (`CHATUSER#<userId>`, `<updatedAt>#<sessionId>`).
 */

const notFound = () => new PersistenceError('REFERENCE_NOT_FOUND', 'Referenced record not found');

/** True for a plain TransactionConflictException or a cancellation with a TransactionConflict reason. */
function isTransactionConflict(err: unknown, codes: string[] | null): boolean {
  return errorName(err) === TRANSACTION_CONFLICT || (codes?.includes('TransactionConflict') ?? false);
}

export function dynamoChatRepository(ctx: DynamoRepositoryContext): ChatRepository {
  /** "User exists" means a USER item with that id, whatever isActive is. */
  async function userExists(userId: string, op: string): Promise<boolean> {
    const res = await send(
      ctx,
      new GetCommand({
        TableName: ctx.tableName,
        Key: userKey(userId),
        ConsistentRead: true,
        ProjectionExpression: '#pk',
        ExpressionAttributeNames: { '#pk': 'PK' },
      }),
      op,
    );
    return res.Item !== undefined;
  }

  async function createSession(input: NewChatSession): Promise<ChatSession> {
    const op = 'chat.createSession';
    const s = parseNewChatSession(input);
    const now = ctx.now();
    const session: ChatSession = {
      id: s.id ?? randomUUID(),
      userId: s.userId,
      title: s.title,
      service: s.service,
      environment: s.environment,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const item = chatSessionItem(session);
    if (!(await userExists(session.userId, op))) throw notFound();
    try {
      await send(
        ctx,
        new PutCommand({
          TableName: ctx.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': 'PK' },
        }),
        op,
        { handled: [CONDITIONAL_CHECK_FAILED] },
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) throw new PersistenceError('DUPLICATE', 'Record already exists');
      throw err;
    }
    return session;
  }

  async function getSession(sessionId: string): Promise<ChatSession | null> {
    const id = parseReadId(sessionId);
    const res = await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: chatSessionKey(id), ConsistentRead: true }),
      'chat.getSession',
    );
    return res.Item ? itemToChatSession(res.Item) : null;
  }

  /** Most recent activity first; the cursor is [updatedAt, id]. */
  async function listSessionsByUser(userId: string, opts: CursorOptions = {}): Promise<CursorPage<ChatSession>> {
    const uid = parseReadId(userId);
    const limit = clampSessionLimit(opts.limit);
    const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor, sessionCursorSchema);
    const input: QueryInput = {
      IndexName: APP_TABLE_GSI1,
      KeyConditionExpression: '#gsi1pk = :user',
      ExpressionAttributeNames: { '#gsi1pk': 'GSI1PK' },
      ExpressionAttributeValues: { ':user': chatUserPk(uid) },
      ScanIndexForward: false,
    };
    if (after) {
      input.ExclusiveStartKey = { ...chatSessionGsi1(uid, after[0], after[1]), PK: chatPk(after[1]), SK: CHAT_SESSION_SK };
    }
    const items = await queryUpTo<StoredItem>(ctx, input, limit + 1, 'chat.listSessionsByUser');
    const more = items.length > limit;
    const page = more ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    return {
      items: page.map(itemToChatSession),
      nextCursor: more && last ? encodeCursor([last.updatedAt, last.id]) : null,
    };
  }

  /**
   * One transaction: Put the message (create-only) and bump the session (must exist). reason[1] gives
   * REFERENCE_NOT_FOUND; an id collision regenerates the id once; a conflict retries once, then UNAVAILABLE.
   */
  async function appendMessage(input: NewChatMessage): Promise<ChatMessage> {
    const op = 'chat.appendMessage';
    const m = parseNewChatMessage(input);
    const now = ctx.now();
    for (let attempt = 1; ; attempt++) {
      const message: ChatMessage = {
        id: newTimeOrderedId(now),
        sessionId: m.sessionId,
        role: m.role,
        content: m.content,
        citations: m.citations,
        provider: m.provider,
        modelId: m.modelId,
        source: m.source,
        latencyMs: m.latencyMs,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        createdAt: now,
        meta: m.meta,
      };
      const command = new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: ctx.tableName,
              Item: chatMessageItem(message),
              ConditionExpression: 'attribute_not_exists(#pk)',
              ExpressionAttributeNames: { '#pk': 'PK' },
            },
          },
          {
            Update: {
              TableName: ctx.tableName,
              Key: chatSessionKey(m.sessionId),
              UpdateExpression: 'SET #updatedAt = :now, #gsi1sk = :gsk ADD #messageCount :one',
              ConditionExpression: 'attribute_exists(#pk)',
              ExpressionAttributeNames: {
                '#updatedAt': 'updatedAt',
                '#gsi1sk': 'GSI1SK',
                '#messageCount': 'messageCount',
                '#pk': 'PK',
              },
              ExpressionAttributeValues: { ':now': now, ':gsk': `${now}#${m.sessionId}`, ':one': 1 },
            },
          },
        ],
      });
      try {
        await send(ctx, command, op, { handled: [TRANSACTION_CANCELED, TRANSACTION_CONFLICT] });
        return message;
      } catch (err) {
        const codes = cancellationCodes(err);
        if (codes?.[1] === 'ConditionalCheckFailed') throw notFound();
        if (codes?.[0] === 'ConditionalCheckFailed') {
          if (attempt === 1) continue;
          throw new PersistenceError('DUPLICATE', 'Record already exists');
        }
        if (isTransactionConflict(err, codes)) {
          if (attempt === 1) continue;
          throw unavailable(op, 'TransactionConflict');
        }
        throw codes === null ? err : translateAwsError(err, op);
      }
    }
  }

  /** Oldest first (ids are time-ordered); the cursor is [id]. */
  async function listMessages(sessionId: string, opts: CursorOptions = {}): Promise<CursorPage<ChatMessage>> {
    const sid = parseReadId(sessionId);
    const limit = clampMessageLimit(opts.limit);
    const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor, messageCursorSchema);
    const input: QueryInput = {
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': chatPk(sid), ':prefix': CHAT_MESSAGE_PREFIX },
      ConsistentRead: true,
    };
    if (after) input.ExclusiveStartKey = chatMessageKey(sid, after[0]);
    const items = await queryUpTo<StoredItem>(ctx, input, limit + 1, 'chat.listMessages');
    const more = items.length > limit;
    const page = more ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    return {
      items: page.map(itemToChatMessage),
      nextCursor: more && last ? encodeCursor([last.id]) : null,
    };
  }

  /**
   * One transaction: ConditionCheck the message in this session, ConditionCheck the user, Update the
   * feedback (created on first use, createdAt kept). Then a strong read returns it.
   */
  async function setFeedback(input: ChatFeedbackInput): Promise<ChatFeedback> {
    const op = 'chat.setFeedback';
    const f = parseChatFeedbackInput(input);
    const now = ctx.now();
    const key = chatFeedbackKey(f.sessionId, f.messageId);
    const command = new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: ctx.tableName,
            Key: chatMessageKey(f.sessionId, f.messageId),
            ConditionExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'PK' },
          },
        },
        {
          ConditionCheck: {
            TableName: ctx.tableName,
            Key: userKey(f.userId),
            ConditionExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'PK' },
          },
        },
        {
          Update: {
            TableName: ctx.tableName,
            Key: key,
            UpdateExpression:
              'SET #entityType = :entityType, #rating = :rating, #comment = :comment, #userId = :userId, ' +
              '#sessionId = :sessionId, #messageId = :messageId, #updatedAt = :now, ' +
              '#createdAt = if_not_exists(#createdAt, :now)',
            ExpressionAttributeNames: {
              '#entityType': 'entityType',
              '#rating': 'rating',
              '#comment': 'comment',
              '#userId': 'userId',
              '#sessionId': 'sessionId',
              '#messageId': 'messageId',
              '#updatedAt': 'updatedAt',
              '#createdAt': 'createdAt',
            },
            ExpressionAttributeValues: {
              ':entityType': 'CHAT_FEEDBACK',
              ':rating': f.rating,
              ':comment': f.comment,
              ':userId': f.userId,
              ':sessionId': f.sessionId,
              ':messageId': f.messageId,
              ':now': now,
            },
          },
        },
      ],
    });
    for (let attempt = 1; ; attempt++) {
      try {
        await send(ctx, command, op, { handled: [TRANSACTION_CANCELED, TRANSACTION_CONFLICT] });
        break;
      } catch (err) {
        const codes = cancellationCodes(err);
        if (codes?.[0] === 'ConditionalCheckFailed' || codes?.[1] === 'ConditionalCheckFailed') throw notFound();
        if (isTransactionConflict(err, codes)) {
          if (attempt === 1) continue;
          throw unavailable(op, 'TransactionConflict');
        }
        throw codes === null ? err : translateAwsError(err, op);
      }
    }
    const res = await send(ctx, new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true }), op);
    if (!res.Item) throw notFound();
    return itemToFeedback(res.Item);
  }

  /** Ordered by message id (the FEEDBACK#<messageId> sort key). */
  async function listFeedback(sessionId: string): Promise<ChatFeedback[]> {
    const sid = parseReadId(sessionId);
    const items = await queryAll<StoredItem>(
      ctx,
      {
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: { ':pk': chatPk(sid), ':prefix': CHAT_FEEDBACK_PREFIX },
        ConsistentRead: true,
      },
      'chat.listFeedback',
    );
    return items.map(itemToFeedback);
  }

  /** Title only; the GSI1 sort key (updatedAt) is untouched. */
  async function renameSession(sessionId: string, title: string): Promise<ChatSession | null> {
    const id = parseReadId(sessionId);
    const t = parseSessionTitle(title);
    try {
      await send(
        ctx,
        new UpdateCommand({
          TableName: ctx.tableName,
          Key: chatSessionKey(id),
          UpdateExpression: 'SET #title = :t',
          ConditionExpression: 'attribute_exists(#pk)',
          ExpressionAttributeNames: { '#title': 'title', '#pk': 'PK' },
          ExpressionAttributeValues: { ':t': t },
        }),
        'chat.renameSession',
        { handled: [CONDITIONAL_CHECK_FAILED] },
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null;
      throw err;
    }
    return getSession(id);
  }

  /** All keys in the CHAT# partition (session, messages, feedback), deleted in batches. Returns the key list. */
  async function deletePartition(id: string, op: string): Promise<Array<{ PK: string; SK: string }>> {
    const keys = await queryAll<{ PK: string; SK: string }>(
      ctx,
      {
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: { ':pk': chatPk(id) },
        ProjectionExpression: '#pk, #sk',
        ConsistentRead: true,
      },
      op,
    );
    if (keys.length) await batchWriteAll(ctx, keys.map((k) => ({ delete: { PK: k.PK, SK: k.SK } })), op);
    return keys;
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    const id = parseReadId(sessionId);
    const keys = await deletePartition(id, 'chat.deleteSession');
    return keys.some((k) => k.SK === CHAT_SESSION_SK);
  }

  async function deleteFeedback(sessionId: string, messageId: string): Promise<boolean> {
    const res = await send(
      ctx,
      new DeleteCommand({
        TableName: ctx.tableName,
        Key: chatFeedbackKey(parseReadId(sessionId), parseReadId(messageId)),
        ReturnValues: 'ALL_OLD',
      }),
      'chat.deleteFeedback',
    );
    return res.Attributes !== undefined;
  }

  const SCAN_CAP = 20_000;

  /** Filtered Scan (no GSI for time-range reads of chat data). Fine for a low-volume quality view; see docs/CHAT.md. */
  async function scanItems(filter: string, names: Record<string, string>, values: Record<string, unknown>, op: string, cap = SCAN_CAP): Promise<StoredItem[]> {
    const out: StoredItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await send(
        ctx,
        new ScanCommand({
          TableName: ctx.tableName,
          FilterExpression: filter,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ExclusiveStartKey: startKey,
          ConsistentRead: true,
        }),
        op,
      );
      for (const item of res.Items ?? []) out.push(item as StoredItem);
      startKey = res.LastEvaluatedKey;
    } while (startKey && out.length < cap);
    return out.slice(0, cap);
  }

  async function serviceBySession(sessionIds: string[], op: string): Promise<Map<string, string | null>> {
    const unique = [...new Set(sessionIds)];
    const items = unique.length ? await batchGetAll<StoredItem>(ctx, unique.map((id) => chatSessionKey(id)), { projection: ['id', 'service'] }, op) : [];
    return new Map(items.map((i) => [i.id as string, (i.service ?? null) as string | null]));
  }

  async function listFeedbackRecords(from: string, to: string): Promise<ChatFeedbackRecord[]> {
    const op = 'chat.listFeedbackRecords';
    const items = await scanItems(
      '#et = :et AND #u BETWEEN :from AND :to',
      { '#et': 'entityType', '#u': 'updatedAt' },
      { ':et': 'CHAT_FEEDBACK', ':from': from, ':to': to },
      op,
    );
    const services = await serviceBySession(items.map((i) => i.sessionId as string), op);
    return items
      .map((i) => ({
        messageId: i.messageId as string,
        sessionId: i.sessionId as string,
        rating: i.rating as ChatFeedbackRecord['rating'],
        comment: (i.comment ?? null) as string | null,
        updatedAt: i.updatedAt as string,
        service: services.get(i.sessionId as string) ?? null,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async function listLatencySamples(from: string, to: string): Promise<ChatLatencySample[]> {
    const op = 'chat.listLatencySamples';
    const items = await scanItems(
      '#et = :et AND #r = :assistant AND attribute_exists(#l) AND #c BETWEEN :from AND :to',
      { '#et': 'entityType', '#r': 'role', '#l': 'latencyMs', '#c': 'createdAt' },
      { ':et': 'CHAT_MESSAGE', ':assistant': 'assistant', ':from': from, ':to': to },
      op,
    );
    const ok = items.filter((i) => i.latencyMs !== null && i.latencyMs !== undefined && !(i.meta as ChatMessageMeta | null | undefined)?.error);
    const services = await serviceBySession(ok.map((i) => i.sessionId as string), op);
    return ok.map((i) => ({
      createdAt: i.createdAt as string,
      service: services.get(i.sessionId as string) ?? null,
      totalMs: i.latencyMs as number,
      providerMs: ((i.meta as ChatMessageMeta | null | undefined)?.providerMs ?? null) as number | null,
    }));
  }

  async function purgeOlderThan(cutoff: string): Promise<ChatPurgeResult> {
    const op = 'chat.purge';
    const sessions = await scanItems('#et = :et AND #u < :cutoff', { '#et': 'entityType', '#u': 'updatedAt' }, { ':et': 'CHAT_SESSION', ':cutoff': cutoff }, op, Number.MAX_SAFE_INTEGER);
    const out: ChatPurgeResult = { sessions: 0, messages: 0, feedback: 0 };
    for (const s of sessions) {
      const keys = await deletePartition(s.id as string, op);
      out.sessions += keys.filter((k) => k.SK === CHAT_SESSION_SK).length;
      out.messages += keys.filter((k) => k.SK.startsWith(CHAT_MESSAGE_PREFIX)).length;
      out.feedback += keys.filter((k) => k.SK.startsWith(CHAT_FEEDBACK_PREFIX)).length;
    }
    return out;
  }

  return {
    createSession, getSession, listSessionsByUser, appendMessage, listMessages, setFeedback, listFeedback,
    renameSession, deleteSession, deleteFeedback, listFeedbackRecords, listLatencySamples, purgeOlderThan,
  };
}
