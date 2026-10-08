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
import { HttpUrbaniLogsAdapter } from './live/HttpUrbaniLogsAdapter';
import { HttpUrbaniChatProvider } from './live/HttpUrbaniChatProvider';
import { HttpUrbaniAlertsAdapter } from './live/HttpUrbaniAlertsAdapter';

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
  /**
   * Live source of AI-generated incident alerts (GET /alerts/latest + /history).
   * Present ONLY in live mode when the Urbani API is configured; undefined in
   * mock mode (alertService then serves seeded MOCK alerts, unchanged).
   */
  urbaniAlerts?: HttpUrbaniAlertsAdapter;
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

/**
 * `live` mode: use real integrations where they are configured and available,
 * and mock for the rest. Today only the Urbani logs API is available, so the
 * CloudWatch adapter becomes the live HTTP adapter and everything else stays
 * mock. The dashboard shows LIVE for logs and MOCK elsewhere via adapter meta —
 * no dashboard or service-layer changes required.
 */
function buildLive(): Integrations {
  const base = buildMock();

  if (config.urbani.logsConfigured) {
    logger.info('Wiring LIVE Urbani logs + alerts + chat via POST /chat (Nova 2 Lite)', {
      integrationMode: 'live',
      services: config.urbani.services,
      environment: config.urbani.environment,
      refreshMinutes: config.urbani.refreshMinutes,
      chatModelId: config.urbani.chatModelId,
      logsHistoryLimit: config.urbani.logsHistoryLimit,
      alertsHistoryLimit: config.urbani.alertsHistoryLimit,
      // NOTE: the API key is intentionally never logged.
    });
    const liveLogs = new HttpUrbaniLogsAdapter(
      config.urbani.apiBaseUrl!,
      config.urbani.apiKey!,
      config.urbani.service,
      config.urbani.refreshMinutes,
      config.urbani.logsHistoryLimit,
      config.urbani.services,
      config.urbani.environment,
      config.urbani.alertsHistoryLimit,
    );
    base.cloudwatch = liveLogs;
    // Real AI chat via POST /chat (Amazon Bedrock Nova 2 Lite). Reads the
    // per-request service from input.service; the internal Mock is used ONLY for
    // analyzeTelemetry delegation (there is no live analyze endpoint).
    base.aiProvider = new HttpUrbaniChatProvider(
      config.urbani.apiBaseUrl!,
      config.urbani.apiKey!,
      config.urbani.service,
      config.urbani.chatModelId,
      config.urbani.chatTimeoutMs,
    );
    // Real AI-generated incident alerts (both services).
    base.urbaniAlerts = new HttpUrbaniAlertsAdapter(
      config.urbani.apiBaseUrl!,
      config.urbani.apiKey!,
      config.urbani.service,
      config.urbani.refreshMinutes,
      config.urbani.services,
      config.urbani.environment,
    );
    // Wire alert evidence into the logs adapter so the Logs page surfaces the
    // real log lines that live inside alert evidence when the /logs/* windows
    // expose none. The alerts adapter already caches per its refresh window, so
    // this adds no extra upstream pressure beyond the existing alert sync.
    liveLogs.setAlertEvidenceSource(base.urbaniAlerts);
  } else {
    logger.warn('INTEGRATION_MODE=live but Urbani logs API is not configured; using mock logs', {
      hint: 'Set URBANI_API_BASE_URL and URBANI_API_KEY to enable live logs.',
    });
  }

  return base;
}

function buildAws(): Integrations {
  // Reserved boundary. Full AWS SDK adapters (AWSBedrockAdapter, AWSDynamoDBAdapter,
  // BedrockAIProvider, EB service discovery) implement the same interfaces and will
  // be constructed here once AWS credentials + model access are confirmed.
  throw new Error(
    'INTEGRATION_MODE=aws is not implemented yet. Use "live" for the available ' +
      'Urbani logs API, or "mock". Full AWS integration is a later phase.',
  );
}

export function getIntegrations(): Integrations {
  if (cached) return cached;
  switch (config.integrationMode) {
    case 'aws':
      cached = buildAws();
      break;
    case 'live':
      cached = buildLive();
      break;
    default:
      cached = buildMock();
  }
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
