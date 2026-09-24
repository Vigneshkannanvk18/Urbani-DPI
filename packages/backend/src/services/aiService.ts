import type { Sourced, Paginated } from '@urbani/shared';
import { getIntegrations } from '../integrations';
import { aiRepository, type AIAnalysisRecord } from '../repositories/aiRepository';
import { logRepository, metricRepository } from '../repositories/telemetryRepository';
import { MOCK_NOTE } from '../integrations/mock/mockData';

/**
 * AI service (Epic 8 / Phase 3 boundary).
 *
 * Orchestrates: gather telemetry -> AIProvider.analyzeTelemetry -> persist
 * finding + usage. The dashboard never knows whether MockAIProvider or
 * BedrockAIProvider produced the result. If no anomaly is detected, no alert
 * is persisted (grounding rule).
 */
export const aiService = {
  listAnalyses(opts: { page?: number; pageSize?: number }): Sourced<Paginated<AIAnalysisRecord>> {
    const { items, total } = aiRepository.query(opts);
    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: {
        items,
        page: Math.max(opts.page ?? 1, 1),
        pageSize: Math.min(Math.max(opts.pageSize ?? 25, 1), 200),
        total,
      },
    };
  },

  getAnalysis(id: string): Sourced<AIAnalysisRecord | null> {
    return { source: 'MOCK', sourceNote: MOCK_NOTE, data: aiRepository.findById(id) };
  },

  /**
   * Run an analysis for a service/environment using currently available telemetry.
   * Persists the AI analysis record and (if an anomaly is found) the alert.
   */
  async analyze(service: string, environment: string): Promise<Sourced<AIAnalysisRecord>> {
    const { aiProvider, dynamodb } = getIntegrations();

    const logs = logRepository.query({ service, pageSize: 100 }).items;
    const metrics = metricRepository.query({ service, limit: 50 });

    const result = await aiProvider.analyzeTelemetry({ logs, metrics, service, environment });

    if (result.alert) {
      // Persist via the DynamoDB adapter boundary (mock now, real later).
      await dynamodb.putAlert(result.alert);
    }

    const id = aiRepository.insert({
      alertId: result.alert?.alertId ?? null,
      timestamp: new Date().toISOString(),
      service,
      environment,
      modelId: result.modelId,
      provider: result.provider,
      anomalyType: result.alert?.anomalyType ?? null,
      confidence: result.alert?.confidence ?? null,
      finding: result.alert,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      dataSource: result.meta.source,
    });

    const record = aiRepository.findById(id)!;
    return { source: result.meta.source, sourceNote: result.meta.note, data: record };
  },
};
