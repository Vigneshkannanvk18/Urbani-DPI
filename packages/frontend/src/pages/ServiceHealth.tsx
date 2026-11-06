import { useState } from 'react';
import { healthApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { PageHeader, Card, AsyncView, Button, fmtTime } from '../components/ui';
import { HealthCard, HEALTH_REFRESH_MS, useHealthStatus } from '../components/health';
import type { HealthStatusResponse } from '@urbani/shared';

/**
 * Service Health (DPI 2 item 9). One card per target: status, provenance, uptime 24h / 7d / 30d, latency sparkline.
 * Honest by design: targets with no health endpoint show WAITING_FOR_INTEGRATION and the setting to add; they are
 * never shown as UP or LIVE. See docs/HEALTH.md.
 */
export function ServiceHealth() {
  const { can } = useAuth();
  const state = useHealthStatus();
  const [override, setOverride] = useState<HealthStatusResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const checkNow = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setOverride(await healthApi.checkNow());
      state.reload();
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setChecking(false);
    }
  };

  // The freshest of: the check-now response, the polled status.
  const data = (() => {
    const polled = state.data;
    if (override && (!polled || override.generatedAt > polled.generatedAt)) return override;
    return polled;
  })();

  return (
    <div className="stack">
      <PageHeader
        title="Service Health"
        subtitle={`Probes run in the background and are stored for uptime. Refreshes every ${HEALTH_REFRESH_MS / 1000} s.`}
        actions={
          can('settings:update') ? (
            <Button onClick={checkNow} disabled={checking} aria-busy={checking}>
              {checking ? 'Checking...' : 'Check now'}
            </Button>
          ) : undefined
        }
      />
      {checkError && <div className="banner" role="alert"><span>{checkError}</span></div>}
      <AsyncView state={{ ...state, data }}>
        {(s) => (
          <>
            {!s.probesEnabled && (
              <div className="banner" role="status">
                <span>Background probing is off on this server (HEALTH_PROBES_ENABLED). Results below come from manual checks only and may be stale.</span>
              </div>
            )}
            {s.configErrors.length > 0 && (
              <div className="banner" role="alert">
                <span>
                  <strong>HEALTH_TARGETS has problems:</strong> {s.configErrors.join('; ')}
                </span>
              </div>
            )}
            <div className="health-grid">
              {s.targets.map((t) => (
                <HealthCard key={t.id} t={t} />
              ))}
            </div>
            <Card title="How to read this page">
              <ul className="text-secondary" style={{ margin: 0, paddingLeft: 'var(--space-5)', lineHeight: 1.6 }}>
                <li><strong>Radar API</strong> is this service (database ping). <strong>Urbani QA telemetry API</strong> is the observability API the dashboard reads logs and alerts from; it is not the health of the customer's QA application.</li>
                <li><strong>QA, Main, Payment</strong> stay WAITING FOR INTEGRATION until a health endpoint is added to HEALTH_TARGETS. They are never shown as UP.</li>
                <li>Uptime is the share of probes that were UP in the window. With fewer than {s.minSamples} samples it shows "insufficient data" instead of a percentage.</li>
                <li>Probe interval: {s.intervalSeconds} s. Generated {fmtTime(s.generatedAt)}.</li>
              </ul>
            </Card>
          </>
        )}
      </AsyncView>
    </div>
  );
}
