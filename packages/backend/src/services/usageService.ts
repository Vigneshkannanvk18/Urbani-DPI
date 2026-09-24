import type { Sourced, UsageRecord, BudgetStatus } from '@urbani/shared';
import { config } from '../config';
import { usageRepository } from '../repositories/telemetryRepository';
import { MOCK_NOTE } from '../integrations/mock/mockData';

/**
 * Usage & Cost service (Epic 10).
 *
 * Cost control is a first-class requirement (historical $5-6k spikes). Budget
 * thresholds come from config; usage figures are MOCK until real AWS billing /
 * Bedrock usage is integrated. Never fabricate live billing.
 */
export const usageService = {
  usage(): Sourced<{ records: UsageRecord[]; totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: number } }> {
    const records = usageRepository.all();
    const totals = records.reduce(
      (acc, r) => ({
        requests: acc.requests + r.aiRequestCount,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        costUsd: Number((acc.costUsd + r.estimatedCostUsd).toFixed(2)),
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    return { source: 'MOCK', sourceNote: MOCK_NOTE, data: { records, totals } };
  },

  cost(): Sourced<BudgetStatus> {
    const records = usageRepository.all();
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const currentDailyCostUsd = Number(
      records.filter((r) => r.date === today).reduce((s, r) => s + r.estimatedCostUsd, 0).toFixed(2),
    );
    const currentMonthlyCostUsd = Number(
      records.filter((r) => r.date.startsWith(month)).reduce((s, r) => s + r.estimatedCostUsd, 0).toFixed(2),
    );

    const state: BudgetStatus['state'] =
      currentMonthlyCostUsd >= config.cost.hardAlertUsd
        ? 'OVER'
        : currentMonthlyCostUsd >= config.cost.softAlertUsd
          ? 'APPROACHING'
          : 'OK';

    return {
      source: 'MOCK',
      sourceNote: MOCK_NOTE,
      data: {
        dailyBudgetUsd: config.cost.dailyBudgetUsd,
        monthlyBudgetUsd: config.cost.monthlyBudgetUsd,
        softAlertUsd: config.cost.softAlertUsd,
        hardAlertUsd: config.cost.hardAlertUsd,
        currentDailyCostUsd,
        currentMonthlyCostUsd,
        state,
      },
    };
  },
};
