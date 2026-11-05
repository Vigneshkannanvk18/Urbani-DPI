import { config } from '../config';
import { PersistenceError } from '../lib/errors';
import { logger } from '../lib/logger';
import { createDynamoContext } from './dynamodb/client';
import { createDynamoRepositories } from './dynamodb';
import { createSqliteRepositories } from './sqlite';
import type { Repositories } from './types';

/**
 * Repository registry (DPI 2 item 1). Same shape as integrations/index.ts: the driver
 * is chosen once, from config.db.driver, on the first getRepositories() call (server.ts
 * makes it at startup, so a bad configuration fails immediately).
 *
 * Callers use `const repos = getRepositories();` inside each function and await every
 * call. Tests swap single repositories with setRepositoriesForTesting and call
 * resetRepositories() (freshTestDb() does).
 */

let cached: Repositories | null = null;

function build(): Repositories {
  if (config.db.driver === 'dynamodb') {
    const { tableName, endpoint } = config.db.dynamodb;
    logger.info('Persistence driver: dynamodb', {
      table: tableName,
      region: config.aws.region,
      endpoint: endpoint ?? 'aws-default-chain',
    });
    if (endpoint && config.isProd) logger.warn('DYNAMODB_ENDPOINT override is set in production', { endpoint });
    // Builds an SDK client only; credentials resolve lazily on the first request.
    return createDynamoRepositories(createDynamoContext({ region: config.aws.region, endpoint, tableName }));
  }
  logger.info('Persistence driver: sqlite', { path: config.db.sqlitePath });
  return createSqliteRepositories();
}

export function getRepositories(): Repositories {
  return (cached ??= build());
}

/** Test hook to inject fakes for single repositories. */
export function setRepositoriesForTesting(overrides: Partial<Repositories>): void {
  cached = { ...(cached ?? build()), ...overrides };
}

export function resetRepositories(): void {
  cached = null;
}

/** DynamoDB startup probe (server.ts, §9.4). Resolves when health.ping succeeds. A PersistenceError with
 *  fatal: true (table missing, access denied, bad credentials) is rethrown; any other error is logged at warn
 *  ('DynamoDB not reachable at startup; /ready reports 503 until it is', { awsError }) and swallowed. */
export async function assertDynamoReachable(repos: Repositories): Promise<void> {
  try {
    await repos.health.ping();
  } catch (err) {
    if (err instanceof PersistenceError && err.fatal) throw err;
    logger.warn('DynamoDB not reachable at startup; /ready reports 503 until it is', {
      awsError:
        err instanceof PersistenceError
          ? (err.awsErrorName ?? err.reason)
          : err instanceof Error
            ? err.name
            : 'unknown',
    });
  }
}

export * from './types';
