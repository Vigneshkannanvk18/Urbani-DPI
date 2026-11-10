/**
 * MOCK_LOG_VOLUME guard (DPI 2 item 13). Synthetic log volume is a load-test / dev aid only:
 * it is honoured ONLY when INTEGRATION_MODE=mock and NODE_ENV is not production. Anywhere else
 * the request is ignored (volume 0) and the caller logs a warning.
 */
export const MOCK_LOG_VOLUME_MAX = 1_000_000;

export interface MockLogVolumeDecision {
  /** Lines to generate (0 = off: current behaviour). */
  volume: number;
  /** True when a volume was requested but ignored. */
  ignored: boolean;
  reason?: string;
}

export function effectiveMockLogVolume(requested: number, integrationMode: string, nodeEnv: string): MockLogVolumeDecision {
  if (!requested || requested <= 0) return { volume: 0, ignored: false };
  if (nodeEnv === 'production') return { volume: 0, ignored: true, reason: 'NODE_ENV=production' };
  if (integrationMode !== 'mock') return { volume: 0, ignored: true, reason: `INTEGRATION_MODE=${integrationMode} (must be mock)` };
  return { volume: Math.min(Math.floor(requested), MOCK_LOG_VOLUME_MAX), ignored: false };
}
