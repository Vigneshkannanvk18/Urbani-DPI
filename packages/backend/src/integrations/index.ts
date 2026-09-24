import { config } from '../config';
import { logger } from '../lib/logger';
import type {
  CloudWatchAdapter,
  BedrockAdapter,
  DynamoDBAdapter,
  UrbaniApplicationAdapter,
} from './types';
import type { AIProvider } from './ai/AIProvider';

import { MockCloudWatchAdapter } from './mock/MockCloudWatchAdapter';
import { MockBedrockAdapter } from './mock/MockBedrockAdapter';
import { MockDynamoDBAdapter } from './mock/MockDynamoDBAdapter';
import { MockUrbaniApplicationAdapter } from './mock/MockUrbaniApplicationAdapter';
import { MockAIProvider } from './ai/MockAIProvider';

/**
 * Integration factory (Phase 1 Mock/Adapter strategy).
 *
 * Selects concrete adapters based on config.integrationMode. Everything above
 * this module depends only on the interfaces, never the concrete classes — so
 * flipping INTEGRATION_MODE=aws (Phase 2) swaps implementations with zero
 * changes to services, API, or dashboard.
 *
 * The `aws` branch intentionally throws until the real adapters are implemented,
 * so the boundary is explicit and no one accidentally ships a half-wired mode.
 */

export interface Integrations {
  cloudwatch: CloudWatchAdapter;
  bedrock: BedrockAdapter;
  dynamodb: DynamoDBAdapter;
  urbaniApp: UrbaniApplicationAdapter;
  aiProvider: AIProvider;
}

let cached: Integrations | null = null;

function buildMock(): Integrations {
  logger.info('Wiring MOCK integrations (Phase 1)', {
    integrationMode: 'mock',
    primaryModelId: config.bedrock.primaryModelId,
  });
  return {
    cloudwatch: new MockCloudWatchAdapter(),
    bedrock: new MockBedrockAdapter(),
    dynamodb: new MockDynamoDBAdapter(),
    urbaniApp: new MockUrbaniApplicationAdapter(),
    // Model id is config-driven, never hardcoded into logic.
    aiProvider: new MockAIProvider(config.bedrock.primaryModelId),
  };
}

function buildAws(): Integrations {
  // Phase 2/3 boundary. Real adapters (AWSCloudWatchAdapter, AWSBedrockAdapter,
  // AWSDynamoDBAdapter, UrbaniApplicationAdapter, BedrockAIProvider) implement the
  // same interfaces and will be constructed here once AWS/AI access is confirmed.
  throw new Error(
    'INTEGRATION_MODE=aws is not implemented in Phase 1. Real AWS/Bedrock adapters ' +
      'are added in Phase 2/3 once client + AWS credentials + model access are confirmed.',
  );
}

export function getIntegrations(): Integrations {
  if (cached) return cached;
  cached = config.integrationMode === 'aws' ? buildAws() : buildMock();
  return cached;
}

/** Test hook to inject fakes. */
export function setIntegrationsForTesting(overrides: Partial<Integrations>): void {
  cached = { ...(cached ?? buildMock()), ...overrides };
}

export function resetIntegrations(): void {
  cached = null;
}

export * from './types';
export * from './ai/AIProvider';
