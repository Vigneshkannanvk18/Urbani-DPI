import type { UrbaniApplicationAdapter, WithMeta } from '../types';
import type { ServiceSummary } from '@urbani/shared';
import { mockServices, MOCK_NOTE } from './mockData';

/**
 * MockUrbaniApplicationAdapter (Phase 1). Returns the seeded QA service roster.
 * QA exposes no service-discovery endpoint, so the roster stays config-sourced
 * and MOCK-labelled; the service layer derives enabled/logGroup at read time.
 */
export class MockUrbaniApplicationAdapter implements UrbaniApplicationAdapter {
  readonly kind = 'URBANI_APP' as const;

  async discoverServices(): Promise<WithMeta<ServiceSummary[]>> {
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: [...mockServices] };
  }
}
