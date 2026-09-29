import { Construct } from 'constructs';
import { aws_budgets as budgets } from 'aws-cdk-lib';
import type { UrbaniConfig } from '../config';

/**
 * Financial safeguards (CostConstruct) — AWS Budgets alerts.
 *
 * Cost control is a first-class requirement (previous AI initiatives spiked to
 * $5–6k). Soft/hard notification thresholds are config-driven. Notifications go
 * to an email set at deploy time via context `-c budgetEmail=...`.
 */
export class CostConstruct extends Construct {
  constructor(scope: Construct, id: string, cfg: UrbaniConfig) {
    super(scope, id);

    const email = (scope.node.tryGetContext('budgetEmail') as string) ?? undefined;
    const subscribers = email
      ? [{ subscriptionType: 'EMAIL', address: email }]
      : // No email provided at synth: leave subscribers empty (add before deploy).
        [];

    new budgets.CfnBudget(this, 'UrbaniMonthlyBudget', {
      budget: {
        budgetName: 'urbani-observability-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: cfg.budgetHardUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: (cfg.budgetSoftUsd / cfg.budgetHardUsd) * 100, // soft alert %
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100, // hard alert at the full budget
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
      ],
    });
  }
}
