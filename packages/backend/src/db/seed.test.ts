import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { config } from '../config';
import { freshTestDb } from '../test/testDb';
import { dynamoHarness, makeTestClock } from '../test/repositoryHarness';
import { getRepositories, resetRepositories, setRepositoriesForTesting } from '../repositories';
import { CliPreconditionError } from './cliErrors';
import { assertAdminPasswordNotDefault, assertSeedTarget, seed } from './seed';

/** The counts mockData produces (design §8.3), read back through the repositories. */
async function expectSeededCounts(): Promise<void> {
  const repos = getRepositories();
  expect(await repos.users.getRole('role-admin')).not.toBeNull();
  expect(await repos.users.getRole('role-viewer')).not.toBeNull();
  const admin = await repos.users.findByEmail(config.auth.seedAdminEmail);
  expect(admin).not.toBeNull();
  expect(admin?.role).toBe('SUPER_ADMIN');
  expect(await repos.services.count()).toBe(4);
  expect(await repos.alerts.countAll()).toBe(3);
  expect((await repos.logs.query({})).total).toBe(60);
  expect(await repos.metrics.query({ limit: 500 })).toHaveLength(24);
  expect(await repos.usage.all()).toHaveLength(7);
  expect(await repos.integrations.all()).toHaveLength(4);
}

describe('seed on SQLite', () => {
  let db: ReturnType<typeof freshTestDb>;

  beforeEach(() => {
    db = freshTestDb();
  });

  afterEach(() => db.close());

  it('loads the mockData counts', async () => {
    await seed();
    await expectSeededCounts();
  });

  it('is idempotent: a second run leaves every count unchanged', async () => {
    await seed();
    const adminId = (await getRepositories().users.findByEmail(config.auth.seedAdminEmail))?.id;
    await seed();
    await expectSeededCounts();
    expect((await getRepositories().users.findByEmail(config.auth.seedAdminEmail))?.id).toBe(adminId);
  });
});

const endpoint = process.env.DYNAMODB_ENDPOINT;

// seed() writes into this file's own UrbaniTest<runId>App table, which is empty before each test.
describe.skipIf(!endpoint)('seed on DynamoDB Local (set DYNAMODB_ENDPOINT to run)', { timeout: 20_000 }, () => {
  const harness = dynamoHarness(endpoint!);

  beforeAll(() => harness.setupSuite(), 60_000);
  beforeEach(async () => {
    setRepositoriesForTesting(await harness.fresh(makeTestClock()));
  });
  afterEach(async () => {
    resetRepositories();
    await harness.cleanup();
  });
  afterAll(() => harness.teardownSuite(), 60_000);

  it('loads the mockData counts', async () => {
    expect(getRepositories().driver).toBe('dynamodb');
    await seed();
    await expectSeededCounts();
  });

  it('is idempotent: a second run leaves every count unchanged', async () => {
    await seed();
    const adminId = (await getRepositories().users.findByEmail(config.auth.seedAdminEmail))?.id;
    await seed();
    await expectSeededCounts();
    expect((await getRepositories().users.findByEmail(config.auth.seedAdminEmail))?.id).toBe(adminId);
  });
});

describe('assertSeedTarget', () => {
  const refusal =
    'Refusing: seeding an AWS DynamoDB table needs --allow-aws (set DYNAMODB_ENDPOINT for DynamoDB Local)';

  it('refuses dynamodb without an endpoint and without --allow-aws', () => {
    let err: unknown = null;
    try {
      assertSeedTarget({ driver: 'dynamodb', dynamodb: { endpoint: null } }, []);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliPreconditionError);
    expect((err as Error).message).toBe(refusal);
  });

  it('passes with --allow-aws', () => {
    expect(() => assertSeedTarget({ driver: 'dynamodb', dynamodb: { endpoint: null } }, ['--allow-aws'])).not.toThrow();
  });

  it('passes when an endpoint is set', () => {
    expect(() =>
      assertSeedTarget({ driver: 'dynamodb', dynamodb: { endpoint: 'http://127.0.0.1:8000' } }, []),
    ).not.toThrow();
  });

  it('passes for the sqlite driver', () => {
    expect(() => assertSeedTarget({ driver: 'sqlite', dynamodb: { endpoint: null } }, [])).not.toThrow();
  });
});

describe('assertAdminPasswordNotDefault', () => {
  it('refuses the public default password in production', () => {
    expect(() => assertAdminPasswordNotDefault(true, 'ChangeMe123!')).toThrow(CliPreconditionError);
    expect(() => assertAdminPasswordNotDefault(true, 'ChangeMe123!')).toThrow(/SEED_ADMIN_PASSWORD/);
  });
  it('allows a custom password in production and the default outside production', () => {
    expect(() => assertAdminPasswordNotDefault(true, 'a-Strong-Secret-4711')).not.toThrow();
    expect(() => assertAdminPasswordNotDefault(false, 'ChangeMe123!')).not.toThrow();
  });
});