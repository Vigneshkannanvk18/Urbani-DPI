import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CliPreconditionError } from './cliErrors';
import { assertLocalEndpoint, parseTablesArgs } from './dynamoTables';
import { parseMigrateArgs } from './migrateSqliteToDynamo';

/**
 * The DynamoDB CLIs (design §8.3.1): argument guards, source-path resolution and main() exit codes.
 * No case reaches DynamoDB: the client module is mocked, and the refusals run before any client exists.
 */

const { createDynamoContext } = vi.hoisted(() => ({ createDynamoContext: vi.fn() }));
// The factory result survives vi.resetModules(), so the spy also sees calls from re-imported modules.
vi.mock('../repositories/dynamodb/client', () => ({ createDynamoContext }));

const TABLES_REFUSAL =
  'Refusing: dynamo:tables only targets DynamoDB Local (set DYNAMODB_ENDPOINT). Cloud tables come from infra/ (CDK).';
const AWS_REFUSAL =
  'Refusing: dynamo:migrate would target AWS DynamoDB. Pass --allow-aws, or set DYNAMODB_ENDPOINT for DynamoDB Local.';

describe('parseTablesArgs', () => {
  it('accepts no flags and --reset', () => {
    expect(parseTablesArgs([])).toEqual({ reset: false });
    expect(parseTablesArgs(['--reset'])).toEqual({ reset: true });
  });

  it('rejects unknown flags and stray tokens', () => {
    expect(() => parseTablesArgs(['--force'])).toThrow(CliPreconditionError);
    expect(() => parseTablesArgs(['reset'])).toThrow(CliPreconditionError);
  });
});

describe('assertLocalEndpoint', () => {
  it('throws CliPreconditionError without an endpoint', () => {
    expect(() => assertLocalEndpoint(null)).toThrow(CliPreconditionError);
    expect(() => assertLocalEndpoint(null)).toThrow(TABLES_REFUSAL);
  });

  it('accepts any non-empty endpoint, including the compose-network form', () => {
    expect(() => assertLocalEndpoint('http://dynamodb-local:8000')).not.toThrow();
    expect(() => assertLocalEndpoint('http://127.0.0.1:8000')).not.toThrow();
  });
});

describe('parseMigrateArgs', () => {
  const base = path.join(os.tmpdir(), 'urbani-cli-base');

  it('requires --source', () => {
    expect(() => parseMigrateArgs([], base)).toThrow(CliPreconditionError);
    expect(() => parseMigrateArgs(['--dry-run'], base)).toThrow(CliPreconditionError);
  });

  it('rejects a missing value', () => {
    expect(() => parseMigrateArgs(['--source'], base)).toThrow(CliPreconditionError);
    expect(() => parseMigrateArgs(['--source', '--dry-run'], base)).toThrow(CliPreconditionError);
  });

  it('rejects unknown flags', () => {
    expect(() => parseMigrateArgs(['--source', 'x.sqlite', '--force'], base)).toThrow(CliPreconditionError);
    expect(() => parseMigrateArgs(['--source', 'x.sqlite', '-n'], base)).toThrow(CliPreconditionError);
  });

  it('rejects a stray token [F33]', () => {
    expect(() => parseMigrateArgs(['--source', 'x.sqlite', 'extra'], base)).toThrow(CliPreconditionError);
    expect(() => parseMigrateArgs(['extra', '--source', 'x.sqlite'], base)).toThrow(CliPreconditionError);
  });

  it('reads --dry-run and --allow-aws', () => {
    expect(parseMigrateArgs(['--source', 'x.sqlite'], base)).toEqual({
      source: path.resolve(base, 'x.sqlite'),
      dryRun: false,
      allowAws: false,
    });
    expect(parseMigrateArgs(['--dry-run', '--source', 'x.sqlite', '--allow-aws'], base)).toEqual({
      source: path.resolve(base, 'x.sqlite'),
      dryRun: true,
      allowAws: true,
    });
  });
});

describe('source path resolution', () => {
  let savedInitCwd: string | undefined;

  beforeEach(() => {
    savedInitCwd = process.env.INIT_CWD;
  });

  afterEach(() => {
    if (savedInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = savedInitCwd;
  });

  it('resolves against the base argument', () => {
    const base = path.join(os.tmpdir(), 'urbani-cli-base');
    expect(parseMigrateArgs(['--source', 'x.sqlite'], base).source).toBe(path.resolve(base, 'x.sqlite'));
  });

  it('resolves against INIT_CWD without a base argument', () => {
    const initCwd = path.join(os.tmpdir(), 'urbani-cli-init-cwd');
    process.env.INIT_CWD = initCwd;
    expect(parseMigrateArgs(['--source', 'x.sqlite']).source).toBe(path.resolve(initCwd, 'x.sqlite'));
  });

  it('resolves against process.cwd() when INIT_CWD is unset', () => {
    delete process.env.INIT_CWD;
    expect(parseMigrateArgs(['--source', 'x.sqlite']).source).toBe(path.resolve(process.cwd(), 'x.sqlite'));
  });

  it('returns an absolute path unchanged', () => {
    const absolute = path.resolve(os.tmpdir(), 'urbani-cli-abs', 'source.sqlite');
    process.env.INIT_CWD = path.join(os.tmpdir(), 'urbani-cli-init-cwd');
    expect(parseMigrateArgs(['--source', absolute], path.join(os.tmpdir(), 'elsewhere')).source).toBe(absolute);
    expect(parseMigrateArgs(['--source', absolute]).source).toBe(absolute);
  });
});

describe('main() exit codes', () => {
  let tmp: string;
  let envSnapshot: NodeJS.ProcessEnv;
  let stderr: MockInstance;
  let log: MockInstance;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urbani-cli-'));
    envSnapshot = { ...process.env };
    createDynamoContext.mockClear();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    stderr.mockRestore();
    log.mockRestore();
    process.env = envSnapshot;
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Sets the environment, then re-imports ./cli after vi.resetModules(): main() maps errors with instanceof,
   * so it must come from the same module graph as the command modules it loads (design §8.3.1).
   */
  async function runMain(argv: string[], env: Record<string, string | undefined> = {}): Promise<number> {
    delete process.env.DYNAMODB_ENDPOINT;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    const { main } = await import('./cli'); // never call a main imported before the reset
    return main(argv);
  }

  /** What reached stderr, line by line: the message of a JSON log line, or the raw text of any other line. */
  const stderrLines = (): string[] =>
    stderr.mock.calls
      .map((call) => String(call[0]))
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        try {
          return String((JSON.parse(line) as { message?: unknown }).message ?? line);
        } catch {
          return line;
        }
      });
  const stderrText = (): string => stderrLines().join('\n');

  /** An empty file is enough: every case below is refused before the file is opened. */
  function existingFile(): string {
    const file = path.join(tmp, 'source.sqlite');
    fs.writeFileSync(file, '');
    return file;
  }

  it("['tables'] without an endpoint resolves 2 and creates no DynamoDB client", async () => {
    expect(await runMain(['tables'])).toBe(2);
    expect(createDynamoContext).not.toHaveBeenCalled();
    expect(stderrLines()).toContain(TABLES_REFUSAL);
  });

  it("['migrate', '--source', <missing file>] resolves 2", async () => {
    const missing = path.join(tmp, 'missing.sqlite');
    expect(await runMain(['migrate', '--source', missing], { DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000' })).toBe(2);
    expect(stderrText()).toContain(`--source is not a regular file: ${missing}`);
    expect(createDynamoContext).not.toHaveBeenCalled();
  });

  it("['migrate', '--source', <existing file>] without an endpoint or --allow-aws resolves 2 with the refusal text [F33]", async () => {
    expect(await runMain(['migrate', '--source', existingFile()])).toBe(2);
    expect(stderrLines()).toContain(AWS_REFUSAL);
    expect(createDynamoContext).not.toHaveBeenCalled();
  });

  it("['bogus'] resolves 2", async () => {
    expect(await runMain(['bogus'])).toBe(2);
    expect(stderrText()).toContain('Usage:');
  });

  it("DYNAMODB_ENDPOINT='ftp://x' resolves 2 and names the variable", async () => {
    expect(await runMain(['migrate', '--source', existingFile()], { DYNAMODB_ENDPOINT: 'ftp://x' })).toBe(2);
    expect(stderrText()).toContain('DYNAMODB_ENDPOINT');
    expect(createDynamoContext).not.toHaveBeenCalled();
  });

  it('resolves a relative --source against INIT_CWD and prints it before checking the file', async () => {
    expect(await runMain(['migrate', '--source', 'rel.sqlite'], { INIT_CWD: tmp })).toBe(2);
    expect(log).toHaveBeenCalledWith(`Source (read-only): ${path.join(tmp, 'rel.sqlite')}`);
  });
});
