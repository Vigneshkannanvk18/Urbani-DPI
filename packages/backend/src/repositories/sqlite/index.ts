import { closeDb } from '../../db/connection';
import type { Repositories, RepositoryOptions } from '../types';
import { sqliteAlertRepository } from './alertRepository';
import {
  sqliteEnvironmentRepository,
  sqliteLogRepository,
  sqliteMetricRepository,
  sqliteServiceRepository,
  sqliteUsageRepository,
} from './telemetryRepository';
import { sqliteUserRepository } from './userRepository';
import { sqliteAIAnalysisRepository } from './aiRepository';
import { sqliteAuditRepository } from './auditRepository';
import { sqliteIntegrationRepository } from './integrationRepository';
import { sqlitePreferencesRepository } from './preferencesRepository';
import { sqliteChatRepository } from './chatRepository';
import { sqliteHealthRepository } from './healthRepository';

/**
 * SQLite driver (DB_DRIVER=sqlite, the default). Every repository calls getDb() per
 * method, so setDbForTesting keeps working, and runs its SQL (including transactions)
 * synchronously inside an async method, so each method stays one atomic unit.
 */

/** Shared by the SQLite repository factories. */
export interface SqliteContext {
  /** Every repository-generated timestamp (ISO-8601 UTC, ms). */
  now: () => string;
}

export function createSqliteRepositories(opts: RepositoryOptions = {}): Repositories {
  const ctx: SqliteContext = { now: opts.now ?? (() => new Date().toISOString()) };
  return {
    driver: 'sqlite',
    alerts: sqliteAlertRepository(ctx),
    services: sqliteServiceRepository(ctx),
    environments: sqliteEnvironmentRepository(ctx),
    logs: sqliteLogRepository(ctx),
    metrics: sqliteMetricRepository(ctx),
    usage: sqliteUsageRepository(ctx),
    aiAnalyses: sqliteAIAnalysisRepository(ctx),
    audit: sqliteAuditRepository(ctx),
    integrations: sqliteIntegrationRepository(ctx),
    users: sqliteUserRepository(ctx),
    preferences: sqlitePreferencesRepository(ctx),
    chat: sqliteChatRepository(ctx),
    health: sqliteHealthRepository(ctx),
    close: async () => closeDb(),
  };
}
