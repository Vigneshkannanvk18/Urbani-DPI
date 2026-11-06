import type { Repositories, RepositoryOptions } from '../types';
import type { DynamoContext } from './client';
import { dynamoAlertRepository } from './alertRepository';
import {
  dynamoEnvironmentRepository,
  dynamoLogRepository,
  dynamoMetricRepository,
  dynamoServiceRepository,
  dynamoUsageRepository,
} from './telemetryRepository';
import { dynamoUserRepository } from './userRepository';
import { dynamoPreferencesRepository } from './preferencesRepository';
import { dynamoAIAnalysisRepository } from './aiRepository';
import { dynamoAuditRepository } from './auditRepository';
import { dynamoIntegrationRepository } from './integrationRepository';
import { dynamoChatRepository } from './chatRepository';
import { dynamoHealthRepository } from './healthRepository';
import { dynamoNotificationRepository } from './notificationRepository';

/**
 * DynamoDB driver (DB_DRIVER=dynamodb): one table `${DYNAMODB_TABLE_PREFIX}App` with keys PK/SK and one
 * overloaded GSI1 (design §5). Repositories send through `ctx.doc` only. Building them makes no network call.
 */

/** Shared by the DynamoDB repository factories. */
export interface DynamoRepositoryContext extends DynamoContext {
  /** Every repository-generated timestamp (ISO-8601 UTC, ms). */
  now: () => string;
}

export function createDynamoRepositories(ctx: DynamoContext, opts: RepositoryOptions = {}): Repositories {
  const rctx: DynamoRepositoryContext = { ...ctx, now: opts.now ?? (() => new Date().toISOString()) };
  return {
    driver: 'dynamodb',
    alerts: dynamoAlertRepository(rctx),
    services: dynamoServiceRepository(rctx),
    environments: dynamoEnvironmentRepository(rctx),
    logs: dynamoLogRepository(rctx),
    metrics: dynamoMetricRepository(rctx),
    usage: dynamoUsageRepository(rctx),
    aiAnalyses: dynamoAIAnalysisRepository(rctx),
    audit: dynamoAuditRepository(rctx),
    integrations: dynamoIntegrationRepository(rctx),
    users: dynamoUserRepository(rctx),
    preferences: dynamoPreferencesRepository(rctx),
    chat: dynamoChatRepository(rctx),
    health: dynamoHealthRepository(rctx),
    notifications: dynamoNotificationRepository(rctx),
    close: async () => ctx.destroy(),
  };
}
