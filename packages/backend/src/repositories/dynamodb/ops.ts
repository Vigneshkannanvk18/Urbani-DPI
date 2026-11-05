import { BatchGetCommand, BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { PersistenceError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { DynamoContext } from './client';

/**
 * Every DynamoDB call goes through send(), which applies translateAwsError (design §5.10). This is the
 * only module that sends Query, BatchGetItem or BatchWriteItem (§5.7): repositories use queryAll,
 * queryCount, queryUpTo, batchGetAll and batchWriteAll. Logs carry the op, the AWS error name and the
 * request id only, never item contents.
 */

export const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';
export const TRANSACTION_CANCELED = 'TransactionCanceledException';
export const TRANSACTION_CONFLICT = 'TransactionConflictException';

/** Output type of a lib-dynamodb command, read from its middleware handler. */
type CommandOutput<C> = C extends {
  resolveMiddleware(...args: never[]): (...a: never[]) => Promise<{ output: infer O }>;
}
  ? O
  : never;

export interface SendOptions {
  abortSignal?: AbortSignal;
  /** Error names the caller handles itself (§5.4): rethrown unchanged and not logged. */
  handled?: readonly string[];
}

export function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'UnknownError';
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return errorName(err) === CONDITIONAL_CHECK_FAILED;
}

/** The CancellationReasons codes of a TransactionCanceledException ('None' = that item did not fail); null otherwise. */
export function cancellationCodes(err: unknown): string[] | null {
  if (errorName(err) !== TRANSACTION_CANCELED) return null;
  const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  return reasons.map((r) => r.Code ?? 'None');
}

/** A non-fatal UNAVAILABLE (HTTP 503), logged like the transient rows of §5.10. */
export function unavailable(op: string, awsError: string, requestId?: string): PersistenceError {
  logger.warn('DynamoDB call failed', { op, awsError, requestId });
  return new PersistenceError('UNAVAILABLE', 'Persistence store temporarily unavailable', { awsErrorName: awsError });
}

const TRANSIENT_ERRORS = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
  'TimeoutError',
  'AbortError',
  'TransactionConflictException',
]);
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);
const FATAL_ERRORS = new Set([
  'ResourceNotFoundException',
  'AccessDeniedException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'MissingAuthenticationTokenException',
  'ExpiredTokenException',
  'CredentialsProviderError',
]);

/**
 * Maps an SDK error that the operation did not consume (§5.10). Returns the error to throw: a
 * PersistenceError for the transient, fatal and item-size rows, otherwise the original error unchanged.
 */
export function translateAwsError(err: unknown, op: string): unknown {
  const e = (err ?? {}) as { code?: unknown; message?: unknown; $metadata?: { requestId?: string } };
  const name = errorName(err);
  const code = typeof e.code === 'string' ? e.code : undefined;
  const requestId = e.$metadata?.requestId;

  if (TRANSIENT_ERRORS.has(name)) return unavailable(op, name, requestId);
  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) return unavailable(op, code, requestId);
  if (FATAL_ERRORS.has(name)) {
    const hint = name === 'ResourceNotFoundException' ? 'create the table (dynamo:tables / IaC)' : 'check the task-role policy';
    logger.error('DynamoDB call failed', { op, awsError: name, hint });
    return new PersistenceError('UNAVAILABLE', 'Persistence store unavailable', { fatal: true, awsErrorName: name });
  }
  if (name === 'ValidationException' && String(e.message ?? '').toLowerCase().includes('item size')) {
    // The error handler logs it at error level.
    return new PersistenceError('ITEM_TOO_LARGE', 'Item too large', { awsErrorName: name });
  }
  logger.error('DynamoDB call failed', { op, awsError: name });
  return err;
}

/** Sends one command through the document client and translates failures (§5.10). */
export async function send<C extends object>(
  ctx: DynamoContext,
  command: C,
  op: string,
  opts: SendOptions = {},
): Promise<CommandOutput<C>> {
  try {
    const output = await ctx.doc.send(command as never, opts.abortSignal ? { abortSignal: opts.abortSignal } : undefined);
    return output as CommandOutput<C>;
  } catch (err) {
    if (opts.handled?.includes(errorName(err))) throw err;
    throw translateAwsError(err, op);
  }
}

/** A Query input without TableName, which always comes from ctx. Repositories build these. */
export type QueryInput = Omit<QueryCommandInput, 'TableName'>;
type StartKey = QueryCommandInput['ExclusiveStartKey'];

/**
 * A strongly consistent base-table Query of one partition (`#pk = :pk`), optionally filtered, projected
 * or descending. `extra` must not reuse the `#pk`/`:pk` placeholders.
 */
export function partitionQuery(
  pk: string,
  extra: {
    filter?: string;
    projection?: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
    descending?: boolean;
  } = {},
): QueryInput {
  return {
    KeyConditionExpression: '#pk = :pk',
    ...(extra.filter ? { FilterExpression: extra.filter } : {}),
    ...(extra.projection ? { ProjectionExpression: extra.projection } : {}),
    ExpressionAttributeNames: { '#pk': 'PK', ...extra.names },
    ExpressionAttributeValues: { ':pk': pk, ...extra.values },
    ConsistentRead: true,
    ...(extra.descending ? { ScanIndexForward: false } : {}),
  };
}

function pageInput(ctx: DynamoContext, input: Omit<QueryInput, 'ExclusiveStartKey'>, startKey: StartKey): QueryCommandInput {
  return { ...input, TableName: ctx.tableName, ...(startKey ? { ExclusiveStartKey: startKey } : {}) };
}

/** Every page until LastEvaluatedKey is absent; Items concatenated in page order. */
export async function queryAll<T = Record<string, unknown>>(
  ctx: DynamoContext,
  input: Omit<QueryInput, 'Select'>,
  op: string,
): Promise<T[]> {
  const { ExclusiveStartKey: first, ...rest } = input;
  const items: T[] = [];
  let startKey: StartKey = first;
  do {
    const page = await send(ctx, new QueryCommand(pageInput(ctx, rest, startKey)), op);
    for (const item of page.Items ?? []) items.push(item as T);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** Select: 'COUNT' on every page; returns the sum of the per-page Count values. */
export async function queryCount(
  ctx: DynamoContext,
  input: Omit<QueryInput, 'Select' | 'ProjectionExpression' | 'ExclusiveStartKey'>,
  op: string,
): Promise<number> {
  let total = 0;
  let startKey: StartKey;
  do {
    const page = await send(ctx, new QueryCommand({ ...pageInput(ctx, input, startKey), Select: 'COUNT' }), op);
    total += page.Count ?? 0;
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return total;
}

/**
 * Pages until `want` items or the end; each page sets Limit = want minus the items so far. Returns at most
 * `want` items. `input` may carry a cursor's ExclusiveStartKey. Used with want = limit + 1.
 */
export async function queryUpTo<T = Record<string, unknown>>(
  ctx: DynamoContext,
  input: Omit<QueryInput, 'Select' | 'Limit'>,
  want: number,
  op: string,
): Promise<T[]> {
  const { ExclusiveStartKey: first, ...rest } = input;
  const items: T[] = [];
  let startKey: StartKey = first;
  while (items.length < want) {
    const page = await send(ctx, new QueryCommand({ ...pageInput(ctx, rest, startKey), Limit: want - items.length }), op);
    for (const item of page.Items ?? []) items.push(item as T);
    startKey = page.LastEvaluatedKey;
    if (!startKey) break;
  }
  return items.slice(0, want);
}

const BATCH_GET_CHUNK = 100;
const BATCH_WRITE_CHUNK = 25;
const BATCH_MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** 50 ms · 2^n plus jitter. */
const backoffMs = (retry: number) => 50 * 2 ** retry + Math.floor(Math.random() * 50);

/**
 * BatchGetItem in chunks of 100 with ConsistentRead: true. UnprocessedKeys are retried up to 5 times
 * (backoff 50 ms·2^n plus jitter), then UNAVAILABLE. Returns the items found, in any order.
 */
export async function batchGetAll<T = Record<string, unknown>>(
  ctx: DynamoContext,
  keys: Array<{ PK: string; SK: string }>,
  opts: { projection?: string[] },
  op: string,
): Promise<T[]> {
  const projection = opts.projection?.length
    ? {
        ProjectionExpression: opts.projection.map((_, i) => `#p${i}`).join(', '),
        ExpressionAttributeNames: Object.fromEntries(opts.projection.map((name, i) => [`#p${i}`, name])),
      }
    : {};
  const found: T[] = [];
  for (let i = 0; i < keys.length; i += BATCH_GET_CHUNK) {
    let pending: Array<Record<string, unknown>> = keys.slice(i, i + BATCH_GET_CHUNK);
    for (let retry = 0; ; retry++) {
      const res = await send(
        ctx,
        new BatchGetCommand({ RequestItems: { [ctx.tableName]: { Keys: pending, ConsistentRead: true, ...projection } } }),
        op,
      );
      for (const item of res.Responses?.[ctx.tableName] ?? []) found.push(item as T);
      pending = res.UnprocessedKeys?.[ctx.tableName]?.Keys ?? [];
      if (pending.length === 0) break;
      if (retry >= BATCH_MAX_RETRIES) throw unavailable(op, 'UnprocessedKeys');
      await sleep(backoffMs(retry));
    }
  }
  return found;
}

/**
 * BatchWriteItem in chunks of 25; UnprocessedItems are retried the same way. Callers pass unique keys,
 * because a batch with duplicate keys is rejected.
 */
export async function batchWriteAll(
  ctx: DynamoContext,
  requests: Array<{ put: Record<string, unknown> } | { delete: { PK: string; SK: string } }>,
  op: string,
): Promise<void> {
  for (let i = 0; i < requests.length; i += BATCH_WRITE_CHUNK) {
    let pending = requests
      .slice(i, i + BATCH_WRITE_CHUNK)
      .map((r) => ('put' in r ? { PutRequest: { Item: r.put } } : { DeleteRequest: { Key: r.delete } }));
    for (let retry = 0; ; retry++) {
      const res = await send(ctx, new BatchWriteCommand({ RequestItems: { [ctx.tableName]: pending } }), op);
      pending = (res.UnprocessedItems?.[ctx.tableName] ?? []) as typeof pending;
      if (pending.length === 0) break;
      if (retry >= BATCH_MAX_RETRIES) throw unavailable(op, 'UnprocessedItems');
      await sleep(backoffMs(retry));
    }
  }
}

/**
 * Runs fn over items with at most `limit` calls in flight; results keep the input order. After the first
 * failure no further item starts, and the returned promise rejects with that failure.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
