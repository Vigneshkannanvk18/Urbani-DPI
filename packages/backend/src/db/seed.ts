import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb, closeDb } from './connection';
import { runMigrations } from './migrate';
import { config } from '../config';
import { logger } from '../lib/logger';
import { userRepository } from '../repositories/userRepository';
import { alertRepository } from '../repositories/alertRepository';
import {
  mockServices,
  mockAlerts,
  mockLogs,
  mockMetrics,
  mockUsage,
} from '../integrations/mock/mockData';

/**
 * Seed script (Task 1.5 / bootstrap). Idempotent: safe to re-run.
 *
 * Loads:
 *  - ADMIN + VIEWER roles
 *  - a bootstrap admin user (credentials from env; dev-only defaults)
 *  - MOCK services, alerts, logs, metrics, usage, and integration rows
 *
 * All seeded telemetry is stored with data_source = 'MOCK'.
 */
async function seed(): Promise<void> {
  // Guard (Part 6): seeding writes MOCK demo data and would overwrite real records.
  // Refuse in production unless explicitly forced, so production data is never reset.
  if (config.isProd && process.env.FORCE_DB_SEED !== 'yes') {
    logger.warn('Skipping seed in production (set FORCE_DB_SEED=yes to override).');
    return;
  }

  runMigrations();
  const db = getDb();
  const now = new Date().toISOString();

  // ---- Roles ----
  userRepository.upsertRole({
    id: 'role-admin',
    name: 'ADMIN',
    description: 'Full administrative access to the observability dashboard',
    permissions: JSON.stringify(['*']),
    created_at: now,
  });
  userRepository.upsertRole({
    id: 'role-viewer',
    name: 'VIEWER',
    description: 'Read-only access to alerts, logs, metrics and dashboards',
    permissions: JSON.stringify(['read']),
    created_at: now,
  });

  // ---- Bootstrap admin ----
  const existing = userRepository.findByEmail(config.auth.seedAdminEmail);
  if (!existing) {
    const passwordHash = await bcrypt.hash(config.auth.seedAdminPassword, 10);
    userRepository.upsertUser({
      id: randomUUID(),
      email: config.auth.seedAdminEmail,
      display_name: 'Urbani Admin',
      password_hash: passwordHash,
      role_id: 'role-admin',
      is_active: 1,
      last_login_at: null,
      created_at: now,
    });
    logger.info('Seeded bootstrap admin user', { email: config.auth.seedAdminEmail });
  } else {
    logger.info('Admin user already exists; skipping', { email: config.auth.seedAdminEmail });
  }

  // ---- Environments & Services ----
  const envs = new Set(mockServices.map((s) => s.environment));
  const envStmt = db.prepare(
    'INSERT OR IGNORE INTO environments (id, name, created_at) VALUES (?, ?, ?)',
  );
  envs.forEach((name) => envStmt.run(`env-${name}`, name, now));

  const svcStmt = db.prepare(
    `INSERT OR REPLACE INTO services
     (id, name, environment, status, error_rate, last_telemetry_at, last_incident_at, data_source, created_at)
     VALUES (@id, @name, @environment, @status, @error_rate, @last_telemetry_at, @last_incident_at, 'MOCK', @created_at)`,
  );
  for (const s of mockServices) {
    svcStmt.run({
      id: s.id,
      name: s.name,
      environment: s.environment,
      status: s.status,
      error_rate: s.errorRate,
      last_telemetry_at: s.lastTelemetryAt,
      last_incident_at: s.lastIncidentAt,
      created_at: now,
    });
  }

  // ---- Alerts (with evidence + actions via repository) ----
  for (const a of mockAlerts) {
    alertRepository.insert(a, 'MOCK', 'OPEN');
  }

  // ---- Logs ----
  const logStmt = db.prepare(
    `INSERT OR REPLACE INTO log_references
     (id, timestamp, level, service, environment, message, data_source)
     VALUES (@id, @timestamp, @level, @service, @environment, @message, 'MOCK')`,
  );
  for (const l of mockLogs) logStmt.run(l);

  // ---- Metrics ----
  const metricStmt = db.prepare(
    `INSERT OR REPLACE INTO metric_snapshots
     (id, service, environment, timestamp, cpu_percent, memory_percent, error_rate,
      request_count, latency_ms_p95, http_5xx_count, instance_restarts, data_source)
     VALUES (@id, @service, @environment, @timestamp, @cpu_percent, @memory_percent, @error_rate,
             @request_count, @latency_ms_p95, @http_5xx_count, @instance_restarts, 'MOCK')`,
  );
  for (const m of mockMetrics) {
    metricStmt.run({
      id: m.id,
      service: m.service,
      environment: m.environment,
      timestamp: m.timestamp,
      cpu_percent: m.cpuPercent,
      memory_percent: m.memoryPercent,
      error_rate: m.errorRate,
      request_count: m.requestCount,
      latency_ms_p95: m.latencyMsP95,
      http_5xx_count: m.http5xxCount,
      instance_restarts: m.instanceRestarts,
    });
  }

  // ---- Usage ----
  const usageStmt = db.prepare(
    `INSERT OR REPLACE INTO usage_records
     (id, date, model_id, ai_request_count, input_tokens, output_tokens, estimated_cost_usd, data_source)
     VALUES (@id, @date, @model_id, @ai_request_count, @input_tokens, @output_tokens, @estimated_cost_usd, 'MOCK')`,
  );
  for (const u of mockUsage) {
    usageStmt.run({
      id: u.id,
      date: u.date,
      model_id: u.modelId,
      ai_request_count: u.aiRequestCount,
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      estimated_cost_usd: u.estimatedCostUsd,
    });
  }

  // ---- Integration rows (Phase 2 boundary state) ----
  const integrations = [
    ['int-cloudwatch', 'CLOUDWATCH', 'CloudWatch Logs & Metrics'],
    ['int-bedrock', 'BEDROCK', 'Amazon Bedrock (AI analysis)'],
    ['int-dynamodb', 'DYNAMODB', 'DynamoDB UrbaniAlerts'],
    ['int-urbani-app', 'URBANI_APP', 'Urbani Application (Elastic Beanstalk)'],
  ];
  const intStmt = db.prepare(
    `INSERT OR REPLACE INTO integrations (id, kind, display_name, mode, status, config_json, updated_at)
     VALUES (?, ?, ?, 'MOCK', 'WAITING_FOR_INTEGRATION', '{}', ?)`,
  );
  for (const [id, kind, name] of integrations) intStmt.run(id, kind, name, now);

  logger.info('Seed complete', {
    services: mockServices.length,
    alerts: mockAlerts.length,
    logs: mockLogs.length,
    metrics: mockMetrics.length,
  });
}

if (require.main === module) {
  seed()
    .then(() => closeDb())
    .catch((err) => {
      logger.error('Seed failed', { message: (err as Error).message });
      process.exit(1);
    });
}

export { seed };
