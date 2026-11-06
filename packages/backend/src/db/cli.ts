import type { AppConfig } from '../config';
import { PersistenceError } from '../lib/errors';
import { CliPreconditionError } from './cliErrors';

/**
 * Entry point of the DynamoDB tooling (design §9.5):
 *   npm run dynamo:tables [-- --reset]
 *   npm run dynamo:migrate -- --source <path> [--dry-run] [--allow-aws]
 * Compiled form: node packages/backend/dist/db/cli.js <tables|migrate> …
 *
 * The only top-level value imports are ./cliErrors and ../lib/errors, which import nothing. The config
 * module validates the environment when it is imported, so it, the logger and the command modules load
 * through await import(): an invalid variable then exits 2 instead of an uncaught exit 1.
 */

const USAGE = [
  'Usage: cli <tables|migrate> [options]',
  '  tables  [--reset]                                   create the app table on DynamoDB Local',
  '  migrate --source <path> [--dry-run] [--allow-aws]   copy a SQLite database into the app table',
].join('\n');

/** The hint for a fatal store error: a missing table, otherwise access or credentials. */
function fatalHint(awsError: string | undefined): string {
  return awsError === 'ResourceNotFoundException'
    ? 'create the table first (npm run dynamo:tables)'
    : 'check the AWS credentials and the table access policy';
}

/** Resolves the process exit code: 0 ok, 1 failed, 2 usage, configuration or precondition error. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'tables' && command !== 'migrate') {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  let config: AppConfig;
  try {
    ({ config } = await import('../config'));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const { logger } = await import('../lib/logger');
  try {
    if (command === 'tables') {
      const { runTables } = await import('./dynamoTables');
      return await runTables(config, rest);
    }
    const { runMigrate } = await import('./migrateSqliteToDynamo');
    return await runMigrate(config, rest);
  } catch (err) {
    if (err instanceof CliPreconditionError) {
      logger.error(err.message);
      return 2;
    }
    if (err instanceof PersistenceError && err.fatal) {
      logger.error(`${command} failed: ${err.message}`, { awsError: err.awsErrorName, hint: fatalHint(err.awsErrorName) });
      return 2;
    }
    logger.error(`${command} failed`, { message: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}

if (require.main === module) void main(process.argv.slice(2)).then((code) => process.exit(code));
