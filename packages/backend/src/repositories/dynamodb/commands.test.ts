import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  ResourceNotFoundException,
  ThrottlingException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { UrbaniIncidentAlert } from '@urbani/shared';
import { PersistenceError, type PersistenceReason } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { encodeCursor } from '../common';
import type { Repositories, UserUpsert } from '../types';
import type { DynamoContext } from './client';
import { createDynamoRepositories } from './index';
import { alertItem, auditItem, emailLockItem, feedbackItem, logItem, serviceItem, userItem, type StoredItem } from './items';
import { queryAll } from './ops';

/**
 * Command shapes of the DynamoDB driver against a recording fake of the document client (design §8.3).
 * No Docker and no network: `send` records each command as { kind, input, options }, where kind is the
 * command class name without its 'Command' suffix.
 */

interface Sent {
  kind: string;
  input: any;
  options: any;
}
type Responder = (call: Sent, index: number) => unknown;

const TABLE = 'TestApp';
const NOW = '2026-10-05T00:00:00.000Z';

function fakeDynamo(respond: Responder = () => ({})) {
  const sent: Sent[] = [];
  const send = vi.fn(async (cmd: any, options?: any) => {
    const call: Sent = { kind: cmd.constructor.name.replace(/Command$/, ''), input: cmd.input, options };
    sent.push(call);
    return respond(call, sent.length - 1);
  });
  const ctx: DynamoContext = {
    client: {} as DynamoContext['client'],
    doc: { send } as unknown as DynamoContext['doc'],
    tableName: TABLE,
    destroy: () => undefined,
  };
  let t = Date.parse('2026-10-01T00:00:00.000Z');
  const repos: Repositories = createDynamoRepositories(ctx, { now: () => new Date((t += 1000)).toISOString() });
  return { ctx, repos, sent, send, of: (kind: string) => sent.filter((c) => c.kind === kind) };
}

const $metadata = { requestId: 'req-1' };
const conditionFailed = () => new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata });
const canceled = (...codes: string[]) =>
  new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata,
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

/** attribute name -> bound value for every `#name = :value` clause of a SET expression. */
function setClauses(input: { UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const setPart = input.UpdateExpression.replace(/^SET /, '').split(/ (?:ADD|REMOVE|DELETE) /)[0];
  for (const clause of setPart.split(/,\s*(?=#)/)) {
    const [lhs, rhs] = clause.split(' = ');
    if (/^:\w+$/.test(rhs)) out.set(input.ExpressionAttributeNames[lhs], input.ExpressionAttributeValues?.[rhs]);
  }
  return out;
}

async function expectReason(p: Promise<unknown>, reason: PersistenceReason): Promise<PersistenceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PersistenceError);
  expect((err as PersistenceError).reason).toBe(reason);
  return err as PersistenceError;
}

function makeAlert(alertId: string, over: Partial<UrbaniIncidentAlert> = {}): UrbaniIncidentAlert {
  return {
    alertId,
    timestamp: NOW,
    service: 'main',
    environment: 'qa',
    severity: 'HIGH',
    anomalyType: 'DatabaseConnectionTimeout',
    summary: 'DB connection pool exhausted',
    evidence: ['evidence line'],
    probableCause: 'Unclosed sessions',
    recommendedActions: ['Check pool size'],
    confidence: 0.8,
    modelId: 'model-test',
    ...over,
  };
}

function makeUser(id: string, email: string, over: Partial<UserUpsert> = {}): UserUpsert {
  return {
    id,
    email,
    display_name: `User ${id}`,
    password_hash: 'hash-not-a-secret',
    role_id: 'role-admin',
    is_active: 1,
    last_login_at: null,
    created_at: NOW,
    ...over,
  };
}

const storedUser = (id: string, email: string, over: Partial<UserUpsert> = {}): StoredItem =>
  userItem({ role: 'QA_OPERATOR', ...makeUser(id, email, over) });

describe('dynamodb command shapes (recording fake)', () => {
  afterEach(() => vi.restoreAllMocks());

  // ------------------------------------------------------------ alerts

  it('upsertLivePreservingStatus SETs the alertItem attributes, if_not_exists(#status) and no ack attribute', async () => {
    const f = fakeDynamo((c) => (c.kind === 'Query' ? { Items: [] } : {}));
    await f.repos.alerts.upsertLivePreservingStatus(makeAlert('ALT-L', { confidence: null }));
    expect(f.of('Put')).toHaveLength(0);
    const updates = f.of('Update');
    expect(updates).toHaveLength(1);
    const { input } = updates[0];
    expect(input.Key).toEqual({ PK: 'ALERT', SK: 'ALT-L' });
    expect(input.ConditionExpression).toBeUndefined();
    expect(input.UpdateExpression).toContain('#status = if_not_exists(#status, :open)');
    expect(input.ExpressionAttributeNames['#status']).toBe('status');
    expect(input.ExpressionAttributeValues[':open']).toBe('OPEN');

    const set = setClauses(input);
    expect(set.get('entityType')).toBe('ALERT');
    expect(set.get('dataSource')).toBe('LIVE');
    expect(set.get('GSI1PK')).toBe('ALERTSRC#LIVE');
    expect(set.get('GSI1SK')).toBe('ALT-L');
    expect(set.get('confidence')).toBeNull();
    expect(set.get('evidence')).toEqual(['evidence line']);
    expect(set.has('createdAt')).toBe(true);
    expect(set.has('status')).toBe(false);
    for (const attr of ['acknowledgedBy', 'acknowledgedAt', 'PK', 'SK']) {
      expect(Object.values(input.ExpressionAttributeNames)).not.toContain(attr);
    }
    // The links were cleared first (unlinkAll's GSI1 selection).
    expect(f.sent[0]).toMatchObject({ kind: 'Query', input: { IndexName: 'GSI1', ExpressionAttributeValues: { ':link': 'ALERTLINK#ALT-L' } } });
  });

  it('acknowledge is conditioned on attribute_exists(#pk) AND #status = :open and returns ALL_NEW', async () => {
    const acked = alertItem(makeAlert('ALT-1'), 'MOCK', 'ACKNOWLEDGED', NOW, { acknowledgedBy: 'ops@urbani.test', acknowledgedAt: NOW });
    const f = fakeDynamo((c) => (c.kind === 'Update' ? { Attributes: acked } : { Items: [] }));
    const got = await f.repos.alerts.acknowledge('ALT-1', 'ops@urbani.test');
    const [u] = f.of('Update');
    expect(u.input.ConditionExpression).toBe('attribute_exists(#pk) AND #status = :open');
    expect(u.input.ExpressionAttributeNames['#pk']).toBe('PK');
    expect(u.input.ExpressionAttributeValues[':open']).toBe('OPEN');
    expect(u.input.ReturnValues).toBe('ALL_NEW');
    expect([...setClauses(u.input).keys()]).toEqual(['status', 'acknowledgedBy', 'acknowledgedAt']);
    expect(setClauses(u.input).get('status')).toBe('ACKNOWLEDGED');
    expect(got).toMatchObject({ alertId: 'ALT-1', status: 'ACKNOWLEDGED', acknowledgedBy: 'ops@urbani.test' });
  });

  it('a ConditionalCheckFailed acknowledge falls back to findById', async () => {
    const current = alertItem(makeAlert('ALT-1'), 'MOCK', 'RESOLVED', NOW);
    const f = fakeDynamo((c) => {
      if (c.kind === 'Update') throw conditionFailed();
      if (c.kind === 'Get') return { Item: current };
      return { Items: [] };
    });
    expect(await f.repos.alerts.acknowledge('ALT-1', 'bob@urbani.test')).toMatchObject({ alertId: 'ALT-1', status: 'RESOLVED' });
    expect(f.sent.map((c) => c.kind)).toEqual(['Update', 'Get', 'Query']);
    expect(f.of('Get')[0].input).toMatchObject({ Key: { PK: 'ALERT', SK: 'ALT-1' }, ConsistentRead: true });

    const missing = fakeDynamo((c) => {
      if (c.kind === 'Update') throw conditionFailed();
      return {};
    });
    expect(await missing.repos.alerts.acknowledge('ALT-NOPE', 'bob@urbani.test')).toBeNull();
  });

  it('replaceDerivedEvidence is conditioned on attribute_exists(#pk); a missing alert is a no-op only for []', async () => {
    const f = fakeDynamo();
    await f.repos.alerts.replaceDerivedEvidence('ALT-1', ['line a', 'line b']);
    const [u] = f.of('Update');
    expect(u.input).toMatchObject({
      Key: { PK: 'ALERT', SK: 'ALT-1' },
      ConditionExpression: 'attribute_exists(#pk)',
      ExpressionAttributeNames: { '#evidence': 'evidence', '#pk': 'PK' },
    });
    expect(setClauses(u.input)).toEqual(new Map([['evidence', ['line a', 'line b']]]));

    const g = fakeDynamo(() => {
      throw conditionFailed();
    });
    await expect(g.repos.alerts.replaceDerivedEvidence('ALT-NOPE', [])).resolves.toBeUndefined();
    await expectReason(g.repos.alerts.replaceDerivedEvidence('ALT-NOPE', ['orphan']), 'REFERENCE_NOT_FOUND');
  });

  it('deleteByDataSource uses conditional DeleteItems, never a batch write, and counts only successes', async () => {
    const f = fakeDynamo((c) => {
      if (c.kind === 'Query' && c.input.ExpressionAttributeValues[':src'] === 'ALERTSRC#MOCK') {
        return { Items: [{ alertId: 'M1' }, { alertId: 'M2' }] };
      }
      if (c.kind === 'Query') return { Items: [] };
      if (c.kind === 'Delete' && c.input.Key.SK === 'M2') throw conditionFailed(); // flipped to LIVE meanwhile
      return {};
    });
    expect(await f.repos.alerts.deleteByDataSource('MOCK')).toBe(1);
    expect(f.of('BatchWrite')).toHaveLength(0);
    const deletes = f.of('Delete');
    const keys = deletes.map((d) => d.input.Key).sort((a, b) => (a.SK < b.SK ? -1 : 1));
    expect(keys).toEqual([
      { PK: 'ALERT', SK: 'M1' },
      { PK: 'ALERT', SK: 'M2' },
    ]);
    for (const d of deletes) {
      expect(d.input.ConditionExpression).toBe('#dataSource = :src');
      expect(d.input.ExpressionAttributeNames).toEqual({ '#dataSource': 'dataSource' });
      expect(d.input.ExpressionAttributeValues).toEqual({ ':src': 'MOCK' });
    }
    expect(f.sent[0].input).toMatchObject({ IndexName: 'GSI1', KeyConditionExpression: '#gsi1pk = :src' });
  });

  // ------------------------------------------------------------ users

  it('upsertUser for a new user: [0] attribute_not_exists(#pk), [1] the lock item with its condition, no [2]', async () => {
    const f = fakeDynamo();
    await f.repos.users.upsertUser(makeUser('u1', 'a@urbani.test'));
    expect(f.of('Get')[0].input).toMatchObject({ Key: { PK: 'USER', SK: 'u1' }, ConsistentRead: true });
    const [tx] = f.of('TransactWrite');
    const items = tx.input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0].Put).toMatchObject({
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'PK' },
      Item: { PK: 'USER', SK: 'u1', entityType: 'USER', email: 'a@urbani.test', role: 'SUPER_ADMIN', isActive: true },
    });
    expect(items[1].Put.Item).toEqual({ PK: 'USER_EMAIL', SK: 'a@urbani.test', entityType: 'USER_EMAIL', userId: 'u1' });
    expect(items[1].Put.ConditionExpression).toBe('attribute_not_exists(#pk) OR #userId = :id');
    expect(items[1].Put.ExpressionAttributeValues).toEqual({ ':id': 'u1' });
  });

  it('upsertUser for an existing user: [0] #email = :prevEmail, the role is kept, [2] only when the email changes', async () => {
    const same = fakeDynamo((c) => (c.kind === 'Get' ? { Item: storedUser('u1', 'a@urbani.test') } : {}));
    await same.repos.users.upsertUser(makeUser('u1', 'a@urbani.test', { display_name: 'Renamed' }));
    let items = same.of('TransactWrite')[0].input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0].Put).toMatchObject({
      ConditionExpression: '#email = :prevEmail',
      ExpressionAttributeNames: { '#email': 'email' },
      ExpressionAttributeValues: { ':prevEmail': 'a@urbani.test' },
      Item: { displayName: 'Renamed', role: 'QA_OPERATOR' },
    });

    const changed = fakeDynamo((c) => (c.kind === 'Get' ? { Item: storedUser('u1', 'old@urbani.test') } : {}));
    await changed.repos.users.upsertUser(makeUser('u1', 'new@urbani.test'));
    items = changed.of('TransactWrite')[0].input.TransactItems;
    expect(items).toHaveLength(3);
    expect(items[1].Put.Item).toEqual(emailLockItem('new@urbani.test', 'u1'));
    expect(items[2].Delete).toMatchObject({
      Key: { PK: 'USER_EMAIL', SK: 'old@urbani.test' },
      ConditionExpression: '#userId = :id',
      ExpressionAttributeValues: { ':id': 'u1' },
    });
  });

  it('upsertUser: [None, ConditionalCheckFailed, None] is DUPLICATE without a retry', async () => {
    const f = fakeDynamo((c) => {
      if (c.kind === 'Get') return { Item: storedUser('u1', 'old@urbani.test') };
      throw canceled('None', 'ConditionalCheckFailed', 'None');
    });
    await expectReason(f.repos.users.upsertUser(makeUser('u1', 'taken@urbani.test')), 'DUPLICATE');
    expect(f.of('TransactWrite')).toHaveLength(1);
    expect(f.of('Get')).toHaveLength(1);
  });

  it('upsertUser: [ConditionalCheckFailed, None, None] twice is UNAVAILABLE after one re-read, warning with ids only', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const f = fakeDynamo((c) => {
      if (c.kind === 'Get') return { Item: storedUser('u1', 'old@urbani.test') };
      throw canceled('ConditionalCheckFailed', 'None', 'None');
    });
    const err = await expectReason(f.repos.users.upsertUser(makeUser('u1', 'new@urbani.test')), 'UNAVAILABLE');
    expect(err.fatal).toBe(false);
    expect(f.of('Get')).toHaveLength(2);
    expect(f.of('TransactWrite')).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('upsertUser: user changed concurrently', { op: 'users.upsertUser', userId: 'u1' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('@urbani.test');
  });

  it('upsertUser: [None, None, ConditionalCheckFailed] twice, old lock owned by another user: a third send without [2] commits', async () => {
    const warn = vi.spyOn(logger, 'warn');
    let transactions = 0;
    const f = fakeDynamo((c) => {
      if (c.kind === 'Get' && c.input.Key.PK === 'USER') return { Item: storedUser('u1', 'old@urbani.test') };
      if (c.kind === 'Get') return { Item: emailLockItem('old@urbani.test', 'u-other') };
      transactions++;
      if (transactions <= 2) throw canceled('None', 'None', 'ConditionalCheckFailed');
      return {};
    });
    await expect(f.repos.users.upsertUser(makeUser('u1', 'new@urbani.test'))).resolves.toBeUndefined();
    const txs = f.of('TransactWrite');
    expect(txs.map((t) => t.input.TransactItems.length)).toEqual([3, 3, 2]);
    expect(txs[2].input.TransactItems.some((i: any) => 'Delete' in i)).toBe(false);
    expect(f.of('Get').map((g) => g.input.Key)).toEqual([
      { PK: 'USER', SK: 'u1' },
      { PK: 'USER', SK: 'u1' },
      { PK: 'USER_EMAIL', SK: 'old@urbani.test' },
    ]);
    expect(f.of('Get').every((g) => g.input.ConsistentRead === true)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('upsertUser: old email lock not owned by user', { userId: 'u1', lockOwner: 'u-other' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('@urbani.test');
  });

  it('recordLogin is conditioned on attribute_exists(#pk); a missing user is a no-op', async () => {
    const f = fakeDynamo();
    await f.repos.users.recordLogin('u1');
    const [u] = f.of('Update');
    expect(u.input).toMatchObject({
      Key: { PK: 'USER', SK: 'u1' },
      UpdateExpression: 'SET #lastLoginAt = :now',
      ConditionExpression: 'attribute_exists(#pk)',
      ExpressionAttributeNames: { '#lastLoginAt': 'lastLoginAt', '#pk': 'PK' },
    });
    const g = fakeDynamo(() => {
      throw conditionFailed();
    });
    await expect(g.repos.users.recordLogin('u-missing')).resolves.toBeUndefined();
  });

  it('findByEmail always makes two strong GetItems, for a known and for an unknown email', async () => {
    const known = fakeDynamo((c) => ({
      Item: c.input.Key.PK === 'USER_EMAIL' ? emailLockItem('a@urbani.test', 'u1') : storedUser('u1', 'a@urbani.test'),
    }));
    expect((await known.repos.users.findByEmail('a@urbani.test'))?.id).toBe('u1');
    expect(known.sent.map((c) => [c.kind, c.input.Key, c.input.ConsistentRead])).toEqual([
      ['Get', { PK: 'USER_EMAIL', SK: 'a@urbani.test' }, true],
      ['Get', { PK: 'USER', SK: 'u1' }, true],
    ]);

    const unknown = fakeDynamo();
    expect(await unknown.repos.users.findByEmail('nobody@urbani.test')).toBeNull();
    expect(unknown.sent.map((c) => [c.kind, c.input.Key, c.input.ConsistentRead])).toEqual([
      ['Get', { PK: 'USER_EMAIL', SK: 'nobody@urbani.test' }, true],
      ['Get', { PK: 'USER', SK: '#none' }, true],
    ]);
  });

  it('findByEmail: a lock naming a user with another email gives null and a warn with the user id only', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const f = fakeDynamo((c) => ({
      Item: c.input.Key.PK === 'USER_EMAIL' ? emailLockItem('a@urbani.test', 'u1') : storedUser('u1', 'other@urbani.test'),
    }));
    expect(await f.repos.users.findByEmail('a@urbani.test')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('findByEmail: email lock does not match user', { userId: 'u1' });
  });

  // ------------------------------------------------------------ preferences, chat, health

  it('preferences.update SETs #entityType = PREFS and #userId, plus only the supplied fields', async () => {
    const stored = { PK: 'PREFS', SK: 'u1', entityType: 'PREFS', userId: 'u1', theme: 'dark', updatedAt: NOW };
    const f = fakeDynamo((c) => (c.kind === 'Get' ? { Item: { PK: 'USER' } } : { Attributes: stored }));
    const prefs = await f.repos.preferences.update('u1', { theme: 'dark' });
    expect(f.of('Get')[0].input).toMatchObject({ Key: { PK: 'USER', SK: 'u1' }, ConsistentRead: true });
    const [u] = f.of('Update');
    expect(u.input).toMatchObject({ Key: { PK: 'PREFS', SK: 'u1' }, ReturnValues: 'ALL_NEW' });
    expect(u.input.ConditionExpression).toBeUndefined();
    const set = setClauses(u.input);
    expect(set.get('entityType')).toBe('PREFS');
    expect(set.get('userId')).toBe('u1');
    expect(set.get('theme')).toBe('dark');
    expect(set.has('updatedAt')).toBe(true);
    expect(set.has('widgetLayoutJson')).toBe(false);
    expect(prefs).toEqual({ userId: 'u1', theme: 'dark', widgetLayout: null, updatedAt: NOW });

    const noUser = fakeDynamo();
    await expectReason(noUser.repos.preferences.update('nobody', { theme: 'dark' }), 'REFERENCE_NOT_FOUND');
    expect(noUser.of('Update')).toHaveLength(0);
  });

  it('appendMessage: one transaction, create-only message Put plus the conditional session bump', async () => {
    const f = fakeDynamo();
    const m = await f.repos.chat.appendMessage({ sessionId: 'sess-1', role: 'user', content: 'hello' });
    const [tx] = f.of('TransactWrite');
    const [put, update] = tx.input.TransactItems;
    expect(tx.input.TransactItems).toHaveLength(2);
    expect(put.Put).toMatchObject({
      ConditionExpression: 'attribute_not_exists(#pk)',
      Item: { PK: 'CHAT#sess-1', SK: `MSG#${m.id}`, entityType: 'CHAT_MESSAGE', content: 'hello', citations: [] },
    });
    expect(update.Update).toMatchObject({
      Key: { PK: 'CHAT#sess-1', SK: 'SESSION' },
      UpdateExpression: 'SET #updatedAt = :now, #gsi1sk = :gsk ADD #messageCount :one',
      ConditionExpression: 'attribute_exists(#pk)',
      ExpressionAttributeValues: { ':now': m.createdAt, ':gsk': `${m.createdAt}#sess-1`, ':one': 1 },
    });

    const missing = fakeDynamo(() => {
      throw canceled('None', 'ConditionalCheckFailed');
    });
    await expectReason(missing.repos.chat.appendMessage({ sessionId: 'sess-x', role: 'user', content: 'x' }), 'REFERENCE_NOT_FOUND');
    expect(missing.of('TransactWrite')).toHaveLength(1);
  });

  it('setFeedback: 3 items, #entityType = CHAT_FEEDBACK, createdAt kept; a failed reason[1] is REFERENCE_NOT_FOUND', async () => {
    const stored = feedbackItem({ messageId: 'msg-1', sessionId: 'sess-1', userId: 'u1', rating: 'LIKE', comment: null, createdAt: NOW, updatedAt: NOW });
    const f = fakeDynamo((c) => (c.kind === 'Get' ? { Item: stored } : {}));
    const fb = await f.repos.chat.setFeedback({ sessionId: 'sess-1', messageId: 'msg-1', userId: 'u1', rating: 'LIKE' });
    const items = f.of('TransactWrite')[0].input.TransactItems;
    expect(items).toHaveLength(3);
    expect(items[0].ConditionCheck).toMatchObject({ Key: { PK: 'CHAT#sess-1', SK: 'MSG#msg-1' }, ConditionExpression: 'attribute_exists(#pk)' });
    expect(items[1].ConditionCheck).toMatchObject({ Key: { PK: 'USER', SK: 'u1' }, ConditionExpression: 'attribute_exists(#pk)' });
    expect(items[2].Update.Key).toEqual({ PK: 'CHAT#sess-1', SK: 'FEEDBACK#msg-1' });
    expect(items[2].Update.UpdateExpression).toContain('#createdAt = if_not_exists(#createdAt, :now)');
    const set = setClauses(items[2].Update);
    expect(set.get('entityType')).toBe('CHAT_FEEDBACK');
    expect(set.get('rating')).toBe('LIKE');
    expect(set.get('comment')).toBeNull();
    expect(f.of('Get')[0].input).toMatchObject({ Key: { PK: 'CHAT#sess-1', SK: 'FEEDBACK#msg-1' }, ConsistentRead: true });
    expect(fb).toEqual({ messageId: 'msg-1', sessionId: 'sess-1', userId: 'u1', rating: 'LIKE', comment: null, createdAt: NOW, updatedAt: NOW });

    const noUser = fakeDynamo(() => {
      throw canceled('None', 'ConditionalCheckFailed', 'None');
    });
    await expectReason(
      noUser.repos.chat.setFeedback({ sessionId: 'sess-1', messageId: 'msg-1', userId: 'nobody', rating: 'LIKE' }),
      'REFERENCE_NOT_FOUND',
    );
  });

  it('health.ping is a strong GetItem of HEALTH/PING with an abort signal', async () => {
    const f = fakeDynamo();
    await f.repos.health.ping();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].kind).toBe('Get');
    expect(f.sent[0].input).toEqual({ TableName: TABLE, Key: { PK: 'HEALTH', SK: 'PING' }, ConsistentRead: true });
    expect(f.sent[0].options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  // ------------------------------------------------------------ error translation

  it('Throttling becomes a non-fatal UNAVAILABLE, logged with op, AWS error name and request id', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const f = fakeDynamo(() => {
      throw new ThrottlingException({ message: 'Rate exceeded', $metadata });
    });
    const err = await expectReason(f.repos.alerts.findById('ALT-1'), 'UNAVAILABLE');
    expect(err.fatal).toBe(false);
    expect(err.statusCode).toBe(503);
    expect(err.awsErrorName).toBe('ThrottlingException');
    expect(warn).toHaveBeenCalledWith('DynamoDB call failed', { op: 'alerts.findById', awsError: 'ThrottlingException', requestId: 'req-1' });

    const network = fakeDynamo(() => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    });
    expect((await expectReason(network.repos.health.ping(), 'UNAVAILABLE')).fatal).toBe(false);
  });

  it('ResourceNotFound becomes a fatal UNAVAILABLE with the create-the-table hint', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const f = fakeDynamo(() => {
      throw new ResourceNotFoundException({ message: 'Requested resource not found', $metadata });
    });
    const err = await expectReason(f.repos.health.ping(), 'UNAVAILABLE');
    expect(err.fatal).toBe(true);
    expect(err.awsErrorName).toBe('ResourceNotFoundException');
    expect(error).toHaveBeenCalledWith('DynamoDB call failed', {
      op: 'health.ping',
      awsError: 'ResourceNotFoundException',
      hint: 'create the table (dynamo:tables / IaC)',
    });
  });

  it('an item-size ValidationException is ITEM_TOO_LARGE; an unknown error is rethrown unchanged and logged with op', async () => {
    const tooBig = fakeDynamo(() => {
      throw Object.assign(new Error('Item size to update has exceeded the maximum allowed size'), { name: 'ValidationException' });
    });
    await expectReason(tooBig.repos.alerts.replaceDerivedEvidence('ALT-1', ['x']), 'ITEM_TOO_LARGE');

    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const boom = Object.assign(new Error('something odd'), { name: 'WeirdServiceError' });
    const f = fakeDynamo(() => {
      throw boom;
    });
    await expect(f.repos.services.count()).rejects.toBe(boom);
    expect(error).toHaveBeenCalledWith('DynamoDB call failed', { op: 'services.count', awsError: 'WeirdServiceError' });
  });

  // ------------------------------------------------------------ pagination

  it('queryAll concatenates both pages and sends the first LastEvaluatedKey as ExclusiveStartKey', async () => {
    const lek = { PK: 'LOG', SK: 'l2' };
    const page = (...ids: string[]) => ids.map((id, i) => logItem({ id, timestamp: `2026-10-05T00:00:0${i}.000Z`, level: 'ERROR', service: 'main', environment: 'qa', message: id }, 'MOCK'));
    const f = fakeDynamo((c) => (c.input.ExclusiveStartKey ? { Items: page('l3') } : { Items: page('l1', 'l2'), LastEvaluatedKey: lek }));
    const items = await queryAll<StoredItem>(
      f.ctx,
      { KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'PK' }, ExpressionAttributeValues: { ':pk': 'LOG' } },
      'test.queryAll',
    );
    expect(items.map((i) => i.id)).toEqual(['l1', 'l2', 'l3']);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0].input.ExclusiveStartKey).toBeUndefined();
    expect(f.sent[1].input.ExclusiveStartKey).toEqual(lek);
    expect(f.sent.every((c) => c.input.TableName === TABLE)).toBe(true);

    const g = fakeDynamo((c) => (c.input.ExclusiveStartKey ? { Items: page('l3') } : { Items: page('l1', 'l2'), LastEvaluatedKey: lek }));
    expect((await g.repos.logs.query({})).total).toBe(3);
  });

  it('queryCount sums Count over pages: countActive is 3 + 4 = 7', async () => {
    const f = fakeDynamo((c) => (c.input.ExclusiveStartKey ? { Count: 4 } : { Count: 3, LastEvaluatedKey: { PK: 'ALERT', SK: 'A3' } }));
    expect(await f.repos.alerts.countActive()).toBe(7);
    expect(f.sent.map((c) => c.input.Select)).toEqual(['COUNT', 'COUNT']);
    expect(f.sent[0].input).toMatchObject({
      KeyConditionExpression: '#pk = :pk',
      FilterExpression: '#status IN (:open, :ack)',
      ExpressionAttributeValues: { ':pk': 'ALERT', ':open': 'OPEN', ':ack': 'ACKNOWLEDGED' },
      ConsistentRead: true,
    });
    expect(f.sent[1].input.ExclusiveStartKey).toEqual({ PK: 'ALERT', SK: 'A3' });
  });

  it('queryUpTo sets Limit to the items still wanted and stops at want', async () => {
    const event = (i: number) =>
      auditItem({ id: `ev-${i}`, timestamp: `2026-10-05T00:00:0${9 - i}.000Z`, actor: 'alice@urbani.test', action: 'LOGIN', target: null, metadataJson: null, result: 'SUCCESS', createdAt: NOW });
    const pages = [
      { Items: [event(1), event(2)], LastEvaluatedKey: { PK: 'AUDIT', SK: 'k2' } },
      { Items: [event(3)], LastEvaluatedKey: { PK: 'AUDIT', SK: 'k3' } },
    ];
    const f = fakeDynamo((_c, i) => pages[i]);
    const page = await f.repos.audit.listByTimeRange({ limit: 2 });
    expect(f.sent.map((c) => c.input.Limit)).toEqual([3, 1]);
    expect(f.sent[1].input.ExclusiveStartKey).toEqual({ PK: 'AUDIT', SK: 'k2' });
    expect(page.items.map((e) => e.id)).toEqual(['ev-1', 'ev-2']);
    expect(page.nextCursor).toBe(encodeCursor([event(2).timestamp as string, 'ev-2']));
  });

  it('services.all groups alertCount across both pages of the ALERT partition', async () => {
    const svc = (id: string, name: string) =>
      serviceItem({ id, name, environment: 'qa', status: 'HEALTHY', errorRate: 0, lastTelemetryAt: null, lastIncidentAt: null }, 'MOCK', NOW);
    const f = fakeDynamo((c) => {
      const pk = c.input.ExpressionAttributeValues[':pk'];
      if (pk === 'SERVICE') return { Items: [svc('svc-payments', 'payments'), svc('svc-main', 'main')] };
      return c.input.ExclusiveStartKey
        ? { Items: [{ service: 'main' }] }
        : { Items: [{ service: 'main' }, { service: 'payments' }], LastEvaluatedKey: { PK: 'ALERT', SK: 'A2' } };
    });
    const all = await f.repos.services.all();
    expect(all.map((s) => [s.name, s.alertCount])).toEqual([
      ['main', 2],
      ['payments', 1],
    ]);
    const alertPages = f.sent.filter((c) => c.input.ExpressionAttributeValues[':pk'] === 'ALERT');
    expect(alertPages).toHaveLength(2);
    expect(alertPages[0].input.ProjectionExpression).toBe('#service');
  });

  it('every base-table read is strongly consistent and no GSI query sets ConsistentRead', async () => {
    const alert = alertItem(makeAlert('A1'), 'MOCK', 'OPEN', NOW);
    const f = fakeDynamo((c) => {
      if (c.kind === 'Get') return { Item: c.input.Key.PK === 'ALERT' ? alert : undefined };
      if (c.kind === 'BatchGet') return { Responses: { [TABLE]: [] } };
      if (c.kind !== 'Query') return {};
      if (c.input.Select === 'COUNT') return { Count: 0 };
      return { Items: !c.input.IndexName && c.input.ExpressionAttributeValues[':pk'] === 'ALERT' ? [alert] : [] };
    });
    const r = f.repos;
    await r.alerts.findById('A1');
    await r.alerts.query({});
    await r.alerts.countAll();
    await r.alerts.deleteByDataSource('MOCK');
    await r.logs.query({});
    await r.logs.byAlert('A1');
    await r.logs.clearAlertLinks('A1');
    await r.logs.linkLogsToAlert('A1', ['l1']);
    await r.metrics.query({});
    await r.usage.all();
    await r.services.all();
    await r.environments.all();
    await r.integrations.all();
    await r.aiAnalyses.query({});
    await r.audit.query({});
    await r.audit.query({ actor: 'alice@urbani.test' });
    await r.audit.listByTimeRange({});
    await r.audit.listByTimeRange({ actor: 'alice@urbani.test', from: NOW });
    await r.chat.getSession('sess-1');
    await r.chat.listSessionsByUser('u1');
    await r.chat.listMessages('sess-1');
    await r.chat.listFeedback('sess-1');
    await r.preferences.get('u1');
    await r.users.findByEmail('a@urbani.test');

    const queries = f.of('Query');
    const gsi = queries.filter((c) => c.input.IndexName !== undefined);
    const base = queries.filter((c) => c.input.IndexName === undefined);
    expect(gsi.length).toBeGreaterThanOrEqual(8);
    for (const q of gsi) {
      expect(q.input.IndexName).toBe('GSI1');
      expect('ConsistentRead' in q.input).toBe(false);
    }
    expect(base.length).toBeGreaterThanOrEqual(12);
    for (const q of base) expect(q.input.ConsistentRead).toBe(true);
    for (const g of f.of('Get')) expect(g.input.ConsistentRead).toBe(true);
    for (const b of f.of('BatchGet')) expect(b.input.RequestItems[TABLE].ConsistentRead).toBe(true);
  });

  // ------------------------------------------------------------ key guard

  it('a 2,000-character or empty id sends no command', async () => {
    const f = fakeDynamo(() => {
      throw new Error('no command expected');
    });
    for (const key of ['k'.repeat(2000), '']) {
      expect(await f.repos.alerts.findById(key)).toBeNull();
      expect(await f.repos.alerts.acknowledge(key, 'alice@urbani.test')).toBeNull();
      expect(await f.repos.services.findById(key)).toBeNull();
      expect(await f.repos.aiAnalyses.findById(key)).toBeNull();
      expect(await f.repos.users.findById(key)).toBeNull();
      expect(await f.repos.users.getRole(key)).toBeNull();
      expect(await f.repos.users.findByEmail(key)).toBeNull();
      expect(await f.repos.logs.byAlert(key)).toEqual([]);
      await expect(f.repos.logs.clearAlertLinks(key)).resolves.toBeUndefined();
      await expect(f.repos.users.recordLogin(key)).resolves.toBeUndefined();
      await expect(f.repos.integrations.delete(key)).resolves.toBeUndefined();
    }
    expect(await f.repos.users.findByEmail(`${'e'.repeat(1993)}@x.test`)).toBeNull();
    expect(await f.repos.audit.query({ actor: 'a'.repeat(2100) })).toEqual({ items: [], total: 0 });
    expect(f.send).not.toHaveBeenCalled();
  });
});
