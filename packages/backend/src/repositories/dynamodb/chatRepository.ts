import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  sessionCursorSchema,
} from '../validation';
import type {
  ChatFeedback,
  ChatFeedbackInput,
  ChatMessage,
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

  return { createSession, getSession, listSessionsByUser, appendMessage, listMessages, setFeedback, listFeedback };
}
