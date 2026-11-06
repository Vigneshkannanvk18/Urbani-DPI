import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
  type DynamoDBClient,
  type KeySchemaElement,
  type TableDescription,
} from '@aws-sdk/client-dynamodb';
import type { AppConfig } from '../config';
import { createDynamoContext } from '../repositories/dynamodb/client';
import { APP_TABLE_GSI1, buildCreateTableInput } from '../repositories/dynamodb/tableDefinition';
import { CliPreconditionError } from './cliErrors';

/**
 * `npm run dynamo:tables [-- --reset]` (design §9.5): creates the app table `${DYNAMODB_TABLE_PREFIX}App` on
 * DynamoDB Local from the same definition the tests use. Cloud tables come from infra/ (CDK), never from here.
 */

export interface TablesArgs {
  reset: boolean;
}

const USAGE = 'Usage: npm run dynamo:tables [-- --reset]';
/** maxWaitTime of the table waiters, in seconds. */
const TABLE_WAIT_SECONDS = 60;

/** Only --reset is accepted; anything else is a usage error (exit 2). */
export function parseTablesArgs(argv: string[]): TablesArgs {
  let reset = false;
  for (const arg of argv) {
    if (arg === '--reset') reset = true;
    else throw new CliPreconditionError(`Unknown argument: ${arg}. ${USAGE}`);
  }
  return { reset };
}

/**
 * Presence check only. With an endpoint set the client always uses the dummy local credentials, which no
 * AWS account accepts, and a loopback-only rule would reject the compose form http://dynamodb-local:8000.
 */
export function assertLocalEndpoint(endpoint: string | null): asserts endpoint is string {
  if (!endpoint) {
    throw new CliPreconditionError(
      'Refusing: dynamo:tables only targets DynamoDB Local (set DYNAMODB_ENDPOINT). Cloud tables come from infra/ (CDK).',
    );
  }
}

async function describeTable(client: DynamoDBClient, tableName: string): Promise<TableDescription | null> {
  try {
    const res = await client.send(new DescribeTableCommand({ TableName: tableName }));
    return res.Table ?? null;
  } catch (err) {
    if ((err as { name?: unknown } | null)?.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

const keySchemaId = (keys: KeySchemaElement[] | undefined): string =>
  (keys ?? [])
    .map((k) => `${k.AttributeName}:${k.KeyType}`)
    .sort()
    .join(',');

/** The table key schema, and GSI1 by name with its key schema, equal the app table definition. */
function matchesDefinition(table: TableDescription, tableName: string): boolean {
  const def = buildCreateTableInput(tableName);
  const gsi = table.GlobalSecondaryIndexes?.find((g) => g.IndexName === APP_TABLE_GSI1);
  const defGsi = def.GlobalSecondaryIndexes?.find((g) => g.IndexName === APP_TABLE_GSI1);
  return (
    keySchemaId(table.KeySchema) === keySchemaId(def.KeySchema) &&
    gsi !== undefined &&
    keySchemaId(gsi.KeySchema) === keySchemaId(defGsi?.KeySchema)
  );
}

async function createTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new CreateTableCommand(buildCreateTableInput(tableName)));
  await waitUntilTableExists({ client, maxWaitTime: TABLE_WAIT_SECONDS }, { TableName: tableName });
}

/**
 * DescribeTable, then: an existing table must match the definition (otherwise "run with --reset", exit 2);
 * with reset it is deleted and recreated; a missing table is created. Waiters allow 60 s.
 */
export async function ensureAppTable(
  client: DynamoDBClient,
  tableName: string,
  opts: { reset: boolean },
): Promise<'created' | 'exists' | 'recreated'> {
  const existing = await describeTable(client, tableName);
  if (!existing) {
    await createTable(client, tableName);
    return 'created';
  }
  if (opts.reset) {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
    await waitUntilTableNotExists({ client, maxWaitTime: TABLE_WAIT_SECONDS }, { TableName: tableName });
    await createTable(client, tableName);
    return 'recreated';
  }
  if (!matchesDefinition(existing, tableName)) {
    throw new CliPreconditionError(
      `Table ${tableName} does not match the app table definition (key schema or ${APP_TABLE_GSI1}); run with --reset`,
    );
  }
  return 'exists';
}

/** Used by db/cli.ts. The endpoint check runs before any client exists; the client is destroyed in finally. */
export async function runTables(cfg: AppConfig, argv: string[]): Promise<number> {
  const args = parseTablesArgs(argv);
  const { endpoint, tableName } = cfg.db.dynamodb;
  assertLocalEndpoint(endpoint);
  const ctx = createDynamoContext({ region: cfg.aws.region, endpoint, tableName });
  try {
    const action = await ensureAppTable(ctx.client, tableName, { reset: args.reset });
    console.log(`Table ${tableName} at ${endpoint}: ${action}`);
    return 0;
  } finally {
    ctx.destroy();
  }
}
