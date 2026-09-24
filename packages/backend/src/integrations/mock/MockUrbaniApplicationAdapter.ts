import type { UrbaniApplicationAdapter, WithMeta } from '../types';
import type { ServiceSummary } from '@urbani/shared';
import { mockServices, MOCK_NOTE } from './mockData';

/**
 * MockUrbaniApplicationAdapter (Phase 1). Returns seeded services/environments.
 * Replaced in Phase 2 by a real adapter that discovers Elastic Beanstalk
 * environments once the client provides the application + AWS details.
 */
export class MockUrbaniApplicationAdapter implements UrbaniApplicationAdapter {
  readonly kind = 'URBANI_APP' as const;

  async discoverServices(): Promise<WithMeta<ServiceSummary[]>> {
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: [...mockServices] };
  }
}
