import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { runMigrations } from './migrate';
import { CliPreconditionError } from './cliErrors';
import { config } from '../config';
import { logger } from '../lib/logger';
import { getRepositories, type DbDriver } from '../repositories';
import {
  mockServices,
  mockAlerts,
  mockLogs,
  mockMetrics,
  mockUsage,
} from '../integrations/mock/mockData';

/**
 * Seed script (Task 1.5 / bootstrap). Idempotent: safe to re-run, on both drivers.
 *
 * Loads:
 *  - ADMIN + VIEWER roles
 *  - a bootstrap admin user (credentials from env; dev-only defaults)
 *  - MOCK services, alerts, logs, metrics, usage, and integration rows
 *
 * All seeded telemetry is stored with data_source = 'MOCK'. Every write goes through
 * the repository registry, so the same seed fills SQLite or DynamoDB (DB_DRIVER).
 */
async function seed(): Promise<void> {
  // Guard (Part 6): seeding writes MOCK demo data and would overwrite real records.
  // Refuse in production unless explicitly forced, so production data is never reset.
  if (config.isProd && process.env.FORCE_DB_SEED !== 'yes') {
    logger.warn('Skipping seed in production (set FORCE_DB_SEED=yes to override).');
    return;
  }

  const repos = getRepositories();

  // ---- Prepare the store ----
  if (repos.driver === 'sqlite') {
    runMigrations();
  } else {
    try {
      await repos.health.ping();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`DynamoDB store is not ready (${reason}); run npm run dynamo:tables first`);
    }
  }
  const now = new Date().toISOString();

  // ---- Roles ----
  await repos.users.upsertRole({
    id: 'role-admin',
    name: 'ADMIN',
    description: 'Full administrative access to the observability dashboard',
    permissions: JSON.stringify(['*']),
    created_at: now,
  });
  await repos.users.upsertRole({
    id: 'role-viewer',
    name: 'VIEWER',
    description: 'Read-only access to alerts, logs, metrics and dashboards',
    permissions: JSON.stringify(['read']),
    created_at: now,
  });

  // ---- Bootstrap admin ----
  const existing = await repos.users.findByEmail(config.auth.seedAdminEmail);
  if (!existing) {
    const passwordHash = await bcrypt.hash(config.auth.seedAdminPassword, 10);
    await repos.users.upsertUser({
      id: randomUUID(),
      email: config.auth.seedAdminEmail,
      display_name: 'Urbani Admin',
      password_hash: passwordHash,
      role_id: 'role-admin',
      is_active: 1,
      last_login_at: null,
      created_at: now,
      role: 'SUPER_ADMIN',
    });
    logger.info('Seeded bootstrap admin user', { email: config.auth.seedAdminEmail });
  } else {
    logger.info('Admin user already exists; skipping', { email: config.auth.seedAdminEmail });
  }

  // ---- Environments & Services ----
  const envs = new Set(mockServices.map((s) => s.environment));
  for (const name of envs) await repos.environments.ensure({ id: `env-${name}`, name });

  for (const s of mockServices) await repos.services.upsert(s, 'MOCK');

  // ---- Alerts (with evidence + actions via repository) ----
  for (const a of mockAlerts) {
    await repos.alerts.insert(a, 'MOCK', 'OPEN');
  }

  // ---- Logs, metrics, usage ----
  await repos.logs.upsertMany(mockLogs, 'MOCK');
  await repos.metrics.upsertMany(mockMetrics, 'MOCK');
  await repos.usage.upsertMany(mockUsage, 'MOCK');

  // ---- Integration rows (Phase 2 boundary state) ----
  // Clean up any stale pre-QA URBANI_APP row (integrations.kind is NOT UNIQUE —
  // only id is PK — so re-seeding with the new id would otherwise leave a
  // duplicate URBANI_APP row on the Settings page). Delete every URBANI_APP row
  // whose id is not the current one; the loop below re-inserts the fresh row.
  for (const r of await repos.integrations.all()) {
    if (r.kind === 'URBANI_APP' && r.id !== 'int-urbani-ecs') await repos.integrations.delete(r.id);
  }
  const integrations = [
    ['int-cloudwatch', 'CLOUDWATCH', 'CloudWatch Logs (ECS: main, payments)'],
    ['int-bedrock', 'BEDROCK', 'Amazon Bedrock — Nova 2 Lite'],
    ['int-dynamodb', 'DYNAMODB', 'AI incident alerts (/alerts API ← DynamoDB)'],
    ['int-urbani-ecs', 'URBANI_APP', 'Urbani QA ECS services (main, payments)'],
  ];
  for (const [id, kind, name] of integrations) {
    await repos.integrations.upsert({
      id,
      kind,
      display_name: name,
      mode: 'MOCK',
      status: 'WAITING_FOR_INTEGRATION',
      config_json: '{}',
      updated_at: now,
    });
  }

  logger.info('Seed complete', {
    services: mockServices.length,
    alerts: mockAlerts.length,
    logs: mockLogs.length,
    metrics: mockMetrics.length,
  });
}

/** Refuses to seed a real AWS table by accident. Throws CliPreconditionError, and the CLI exits 2. */
export function assertSeedTarget(db: { driver: DbDriver; dynamodb: { endpoint: string | null } }, argv: string[]): void {
  if (db.driver === 'dynamodb' && !db.dynamodb.endpoint && !argv.includes('--allow-aws')) {
    throw new CliPreconditionError(
      'Refusing: seeding an AWS DynamoDB table needs --allow-aws (set DYNAMODB_ENDPOINT for DynamoDB Local)');
  }
}

if (require.main === module) {
  const run = async (): Promise<void> => {
    // NFR1 guard first, before any repository is built.
    assertSeedTarget(config.db, process.argv.slice(2));
    await seed();
    await getRepositories().close();
  };
  run().catch((err) => {
    if (err instanceof CliPreconditionError) {
      logger.error(err.message);
      process.exit(2);
    }
    logger.error('Seed failed', { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

export { seed };
