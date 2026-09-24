import type { DynamoDBAdapter, AlertQuery, WithMeta } from '../types';
import type { UrbaniIncidentAlert } from '@urbani/shared';
import { alertRepository } from '../../repositories/alertRepository';
import { MOCK_NOTE } from './mockData';

/**
 * MockDynamoDBAdapter (Phase 1). Persists alerts in the local SQLite store via
 * the alert repository so the dashboard has real, queryable persistence during
 * development. Swapped for AWSDynamoDBAdapter (real UrbaniAlerts table) in P2.
 */
export class MockDynamoDBAdapter implements DynamoDBAdapter {
  readonly kind = 'DYNAMODB' as const;

  async putAlert(alert: UrbaniIncidentAlert): Promise<WithMeta<void>> {
    alertRepository.insert(alert, 'MOCK');
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: undefined };
  }

  async getAlert(alertId: string): Promise<WithMeta<UrbaniIncidentAlert | null>> {
    const found = alertRepository.findById(alertId);
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: found };
  }

  async queryAlerts(
    query: AlertQuery,
  ): Promise<WithMeta<{ items: UrbaniIncidentAlert[]; total: number }>> {
    const res = alertRepository.query(query);
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: res };
  }
}
