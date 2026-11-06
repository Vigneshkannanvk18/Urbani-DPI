import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { config } from '../config';
import { ensureAppTable } from '../db/dynamoTables';
import { createDynamoRepositories } from '../repositories/dynamodb';
import { createDynamoContext, type DynamoContext } from '../repositories/dynamodb/client';
import { batchWriteAll } from '../repositories/dynamodb/ops';
import { createSqliteRepositories } from '../repositories/sqlite';
import type { Repositories } from '../repositories/types';
import { freshTestDb } from './testDb';

/**
 * Drives the repository contract suite (design §8.1) against one driver. Each test gets an
 * empty store and repositories bound to its own clock.
 */
export interface RepositoryHarness {
  readonly name: 'sqlite' | 'dynamodb';
  /** beforeAll (timeout 60 s). */
  setupSuite(): Promise<void>;
  /** beforeEach: empty store + repositories bound to the clock. */
  fresh(now: () => string): Promise<Repositories>;
  /** afterEach. */
  cleanup(): Promise<void>;
  /** afterAll. */
  teardownSuite(): Promise<void>;
}

/** SQLite: fresh = freshTestDb() + createSqliteRepositories({ now }); cleanup closes that database. */
export function sqliteHarness(): RepositoryHarness {
  let db: Database.Database | null = null;
  return {
    name: 'sqlite',
    async setupSuite() {},
    async fresh(now) {
      db = freshTestDb();
      return createSqliteRepositories({ now });
    },
    async cleanup() {
      db?.close();
      db = null;
    },
    async teardownSuite() {},
  };
}

export interface DynamoHarness extends RepositoryHarness {
  readonly name: 'dynamodb';
  /** UrbaniTest<runId>App, fixed when the harness is built. */
  readonly tableName: string;
  /** Valid after setupSuite; throws before it. */
  context(): DynamoContext;
  /** Every item in the test table, for assertions. */
  scanAll(): Promise<Array<Record<string, unknown>>>;
}

/**
 * DynamoDB Local: one table per test file, created in setupSuite from the dynamo:tables definition,
 * purged before each test and deleted in teardownSuite. Building the harness does no I/O, so a skipped
 * suite opens no connection. Scans happen here only; repositories never Scan. Tests never use
 * config.db.dynamodb.tableName, so a developer's UrbaniApp table is never touched.
 */
export function dynamoHarness(endpoint: string): DynamoHarness {
  const tableName = `UrbaniTest${Date.now().toString(36)}${randomBytes(2).toString('hex')}App`;
  let ctx: DynamoContext | null = null;

  function context(): DynamoContext {
    if (!ctx) throw new Error('dynamoHarness: context() is only valid after setupSuite()');
    return ctx;
  }

  /** Every page of a strongly consistent Scan; keysOnly projects PK and SK. */
  async function scan(keysOnly: boolean): Promise<Array<Record<string, unknown>>> {
    const c = context();
    const items: Array<Record<string, unknown>> = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await c.doc.send(
        new ScanCommand({
          TableName: c.tableName,
          ConsistentRead: true,
          ...(keysOnly ? { ProjectionExpression: '#pk, #sk', ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' } } : {}),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  return {
    name: 'dynamodb',
    tableName,
    async setupSuite() {
      ctx = createDynamoContext({ region: config.aws.region, endpoint, tableName });
      await ensureAppTable(ctx.client, tableName, { reset: false });
    },
    async fresh(now) {
      const c = context();
      const keys = (await scan(true)) as Array<{ PK: string; SK: string }>;
      await batchWriteAll(c, keys.map((k) => ({ delete: { PK: k.PK, SK: k.SK } })), 'harness.purge');
      return createDynamoRepositories(c, { now });
    },
    async cleanup() {},
    async teardownSuite() {
      if (!ctx) return;
      const c = ctx;
      ctx = null;
      try {
        await c.client.send(new DeleteTableCommand({ TableName: tableName }));
      } finally {
        c.destroy();
      }
    },
    context,
    scanAll: () => scan(false),
  };
}

/** A strictly increasing clock: startIso, startIso + stepMs, … (ISO-8601 UTC with milliseconds). */
export function makeTestClock(startIso = '2026-10-01T00:00:00.000Z', stepMs = 1000): () => string {
  let next = Date.parse(startIso);
  return () => {
    const value = new Date(next).toISOString();
    next += stepMs;
    return value;
  };
}
