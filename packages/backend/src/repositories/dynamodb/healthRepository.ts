import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { HealthRepository } from '../types';
import type { DynamoRepositoryContext } from './index';
import { healthKey } from './keys';
import { send } from './ops';

/**
 * Readiness probe (GET /ready, server start, seed), DynamoDB driver: a strong GetItem of the never-written
 * HEALTH/PING sentinel with a 2 s abort. A missing table or bad credentials surface as fatal UNAVAILABLE.
 */
export function dynamoHealthRepository(ctx: DynamoRepositoryContext): HealthRepository {
  async function ping(): Promise<void> {
    await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: healthKey(), ConsistentRead: true }),
      'health.ping',
      { abortSignal: AbortSignal.timeout(2000) },
    );
  }

  return { ping };
}
