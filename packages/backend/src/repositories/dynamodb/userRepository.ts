import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { UserRole } from '@urbani/shared';
import { PersistenceError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { buildAuthUser } from '../common';
import { parseUserRole } from '../validation';
import type { AuthUser, RoleRow, UserRepository, UserRow, UserUpsert } from '../types';
import type { DynamoRepositoryContext } from './index';
import { assertKeyFits, emailLockItem, itemToRole, itemToUser, roleItem, userItem, type DynamoItem, type StoredItem } from './items';
import { fitsKey, ROLE_PK, roleKey, USER_EMAIL_PK, USER_PK, userEmailKey, userKey } from './keys';
import {
  cancellationCodes,
  CONDITIONAL_CHECK_FAILED,
  errorName,
  isConditionalCheckFailed,
  partitionQuery,
  queryAll,
  send,
  TRANSACTION_CANCELED,
  TRANSACTION_CONFLICT,
  translateAwsError,
} from './ops';

/**
 * Users and roles, DynamoDB driver (design §5.3 patterns 1–6, §5.4). Email uniqueness is a
 * `USER_EMAIL/<email>` lock item written in the same transaction as the user.
 */

const OP_UPSERT = 'users.upsertUser';

/** Which items of the upsert transaction failed: [0] user Put, [1] lock Put, [2] old-lock Delete. */
interface TxFailure {
  user: boolean;
  lock: boolean;
  oldLock: boolean;
}

const duplicate = () => new PersistenceError('DUPLICATE', 'Record already exists');

export function dynamoUserRepository(ctx: DynamoRepositoryContext): UserRepository {
  async function getItem(key: { PK: string; SK: string }, op: string): Promise<StoredItem | undefined> {
    const res = await send(ctx, new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true }), op);
    return res.Item;
  }

  /**
   * Always two strong GetItems (lock, then user), so known and unknown emails cost the same. The user is
   * returned only if the lock exists, the user's stored email equals `email` and the user is active.
   */
  async function findByEmail(email: string): Promise<UserRow | null> {
    if (!fitsKey(USER_EMAIL_PK, email)) return null;
    const op = 'users.findByEmail';
    const lock = await getItem(userEmailKey(email), op);
    const lockOwner = typeof lock?.userId === 'string' ? lock.userId : undefined;
    const user = await getItem(userKey(lockOwner ?? '#none'), op);
    if (!lock || !user) return null;
    if (user.email !== email) {
      logger.warn('findByEmail: email lock does not match user', { userId: user.id });
      return null;
    }
    return user.isActive ? itemToUser(user) : null;
  }

  async function findById(id: string): Promise<UserRow | null> {
    if (!fitsKey(USER_PK, id)) return null;
    const user = await getItem(userKey(id), 'users.findById');
    return user?.isActive ? itemToUser(user) : null;
  }

  async function getById(id: string): Promise<UserRow | null> {
    if (!fitsKey(USER_PK, id)) return null;
    const user = await getItem(userKey(id), 'users.getById');
    return user ? itemToUser(user) : null;
  }

  async function list(): Promise<UserRow[]> {
    const items = await queryAll<StoredItem>(ctx, partitionQuery(USER_PK), 'users.list');
    return items.map(itemToUser).sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  }

  async function getRole(roleId: string): Promise<RoleRow | null> {
    if (!fitsKey(ROLE_PK, roleId)) return null;
    const role = await getItem(roleKey(roleId), 'users.getRole');
    return role ? itemToRole(role) : null;
  }

  async function toAuthUser(user: UserRow): Promise<AuthUser> {
    return buildAuthUser(user, await getRole(user.role_id));
  }

  /** A missing user is a no-op: the condition keeps the update from creating an item. */
  async function recordLogin(id: string): Promise<void> {
    if (!fitsKey(USER_PK, id)) return;
    try {
      await send(
        ctx,
        new UpdateCommand({
          TableName: ctx.tableName,
          Key: userKey(id),
          UpdateExpression: 'SET #lastLoginAt = :now',
          ConditionExpression: 'attribute_exists(#pk)',
          ExpressionAttributeNames: { '#lastLoginAt': 'lastLoginAt', '#pk': 'PK' },
          ExpressionAttributeValues: { ':now': ctx.now() },
        }),
        'users.recordLogin',
        { handled: [CONDITIONAL_CHECK_FAILED] },
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }

  async function upsertRole(row: RoleRow): Promise<void> {
    await send(ctx, new PutCommand({ TableName: ctx.tableName, Item: roleItem(row) }), 'users.upsertRole');
  }

  /**
   * [0] Put the user, conditioned on the state read before (absent, or still on prevEmail); [1] Put the
   * lock, free or already ours; [2] if the email changed, Delete the old lock if it is ours.
   */
  function upsertTransaction(user: DynamoItem, lock: DynamoItem, prevEmail: string | null, deleteOldLock: boolean) {
    const userId = user.id as string;
    return new TransactWriteCommand({
      TransactItems: [
        {
          Put:
            prevEmail === null
              ? {
                  TableName: ctx.tableName,
                  Item: user,
                  ConditionExpression: 'attribute_not_exists(#pk)',
                  ExpressionAttributeNames: { '#pk': 'PK' },
                }
              : {
                  TableName: ctx.tableName,
                  Item: user,
                  ConditionExpression: '#email = :prevEmail',
                  ExpressionAttributeNames: { '#email': 'email' },
                  ExpressionAttributeValues: { ':prevEmail': prevEmail },
                },
        },
        {
          Put: {
            TableName: ctx.tableName,
            Item: lock,
            ConditionExpression: 'attribute_not_exists(#pk) OR #userId = :id',
            ExpressionAttributeNames: { '#pk': 'PK', '#userId': 'userId' },
            ExpressionAttributeValues: { ':id': userId },
          },
        },
        ...(deleteOldLock && prevEmail !== null
          ? [
              {
                Delete: {
                  TableName: ctx.tableName,
                  Key: userEmailKey(prevEmail),
                  ConditionExpression: '#userId = :id',
                  ExpressionAttributeNames: { '#userId': 'userId' },
                  ExpressionAttributeValues: { ':id': userId },
                },
              },
            ]
          : []),
      ],
    });
  }

  /**
   * Sends the transaction. Resolves null on commit, or which items failed. A plain
   * TransactionConflictException gets one immediate retry, then UNAVAILABLE. Codes other than
   * ConditionalCheckFailed and TransactionConflict go through translateAwsError.
   */
  async function runUpsertTransaction(command: TransactWriteCommand): Promise<TxFailure | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        await send(ctx, command, OP_UPSERT, { handled: [TRANSACTION_CANCELED, TRANSACTION_CONFLICT] });
        return null;
      } catch (err) {
        if (errorName(err) === TRANSACTION_CONFLICT) {
          if (attempt === 1) continue;
          throw translateAwsError(err, OP_UPSERT);
        }
        const codes = cancellationCodes(err);
        if (codes === null) throw err; // send() already translated it
        const conflict = codes.includes('TransactionConflict');
        const failed = codes.map((c) => c === 'ConditionalCheckFailed');
        const unexpected = codes.some((c) => c !== 'None' && c !== 'ConditionalCheckFailed' && c !== 'TransactionConflict');
        if (unexpected || (!conflict && !failed.includes(true))) throw translateAwsError(err, OP_UPSERT);
        // A TransactionConflict on any item counts as a failed [0]: another writer was changing the user or a lock.
        return { user: failed[0] === true || conflict, lock: failed[1] === true, oldLock: failed[2] === true };
      }
    }
  }

  /** The §5.4 decision table: at most two attempts, plus one send in the inconsistent-old-lock case. */
  async function upsertUser(row: UserUpsert): Promise<void> {
    const requestedRole = parseUserRole(row.role);
    assertKeyFits(userKey(row.id));
    const lock = emailLockItem(row.email, row.id);
    /** The user or its locks kept changing under us: UNAVAILABLE (503), logged with ids only. */
    const giveUp = () => {
      logger.warn('upsertUser: user changed concurrently', { op: OP_UPSERT, userId: row.id });
      return new PersistenceError('UNAVAILABLE', 'Persistence store temporarily unavailable');
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const current = await getItem(userKey(row.id), OP_UPSERT);
      const role: UserRole = requestedRole ?? (current?.role as UserRole | undefined) ?? 'SUPER_ADMIN';
      const user = userItem({ ...row, role });
      const prevEmail = current ? (current.email as string) : null;
      const emailChanged = prevEmail !== null && prevEmail !== row.email;

      const failure = await runUpsertTransaction(upsertTransaction(user, lock, prevEmail, emailChanged));
      if (failure === null) return;
      if (failure.user) {
        if (attempt === 1) continue;
        throw giveUp();
      }
      if (failure.oldLock) {
        if (attempt === 1) continue;
        if (failure.lock) throw duplicate();
        const oldLock = await getItem(userEmailKey(prevEmail as string), OP_UPSERT);
        if (oldLock && oldLock.userId === row.id) throw giveUp();
        // Already inconsistent: the old lock is gone or names another user. Commit without the delete.
        logger.warn('upsertUser: old email lock not owned by user', {
          userId: row.id,
          lockOwner: typeof oldLock?.userId === 'string' ? oldLock.userId : null,
        });
        const final = await runUpsertTransaction(upsertTransaction(user, lock, prevEmail, false));
        if (final === null) return;
        if (final.user) throw giveUp();
        throw duplicate();
      }
      // Only the lock failed: the email belongs to another user.
      throw duplicate();
    }
  }

  return { findByEmail, findById, getById, list, getRole, toAuthUser, recordLogin, upsertRole, upsertUser };
}
