import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { HealthSeriesPoint, HealthStatus, HealthTargetStatus, UptimeWindow } from '@urbani/shared';
import { healthApi } from '../api/endpoints';
import { useApi } from '../hooks/useApi';
import { SourceBadge, fmtTime } from './ui';

/** Building blocks of the Service Health page and the Dashboard strip (DPI 2 item 9). */
export const HEALTH_REFRESH_MS = 30_000;

const LABEL: Record<HealthStatus, string> = {
  UP: 'UP',
  DEGRADED: 'DEGRADED',
  DOWN: 'DOWN',
  UNKNOWN: 'UNKNOWN',
  WAITING_FOR_INTEGRATION: 'WAITING FOR INTEGRATION',
};

export function HealthStatusBadge({ status }: { status: HealthStatus }) {
  // Dot + text label: never colour-only.
  return (
    <span className={`status-badge st-${status}`}>
      <span className="badge-dot" aria-hidden />
      {LABEL[status]}
    </span>
  );
}

/** Loads GET /api/health/status and refreshes it every 30 s while mounted. */
export function useHealthStatus() {
  const state = useApi(() => healthApi.status(), []);
  const { reload } = state;
  useEffect(() => {
    const t = setInterval(reload, HEALTH_REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);
  return state;
}

export function uptimeLabel(w: UptimeWindow): { value: string; sub: string } {
  if (w.insufficientData) return { value: 'n/a', sub: `insufficient data (${w.samples} samples)` };
  return { value: `${w.uptimePct}%`, sub: `${w.samples} samples` };
}

/** Plain-SVG latency sparkline (no chart dependency). Failed / degraded samples are marked with a dot. */
export function Sparkline({ points, label }: { points: HealthSeriesPoint[]; label: string }) {
  const withLatency = points.filter((p) => p.latencyMs !== null);
  if (points.length < 2 || withLatency.length < 2) {
    return <div className="spark-empty">{points.length === 0 ? 'No samples yet' : 'Not enough samples for a trend'}</div>;
  }
  const W = 200;
  const H = 40;
  const max = Math.max(...withLatency.map((p) => p.latencyMs as number), 1);
  const x = (i: number) => (i / (points.length - 1)) * (W - 4) + 2;
  const y = (v: number) => H - 4 - (v / max) * (H - 8);
  let path = '';
  points.forEach((p, i) => {
    if (p.latencyMs === null) return;
    path += `${path === '' || points[i - 1]?.latencyMs == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.latencyMs).toFixed(1)} `;
  });
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: latency over the last 24 hours, peak ${max} ms`}>
      <path className="spark-line" d={path.trim()} />
      {points.map((p, i) =>
        p.status === 'UP' ? null : (
          <circle key={p.timestamp} className={`spark-dot-${p.status}`} cx={x(i)} cy={p.latencyMs === null ? H - 3 : y(p.latencyMs)} r={2.5} />
        ),
      )}
    </svg>
  );
}

const SEV_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

export function OpenAlerts({ counts }: { counts: HealthTargetStatus['openAlerts'] }) {
  if (!counts) return null;
  const total = SEV_ORDER.reduce((n, s) => n + counts[s], 0);
  return (
    <div className="health-alerts" aria-label="Open alerts for the matching service">
      <span className="text-secondary">Open alerts: {total}</span>
      {SEV_ORDER.filter((s) => counts[s] > 0).map((s) => (
        <span key={s} className={`badge sev-${s}`}>{s} {counts[s]}</span>
      ))}
    </div>
  );
}

export function HealthCard({ t }: { t: HealthTargetStatus }) {
  const waiting = t.status === 'WAITING_FOR_INTEGRATION';
  return (
    <section className="card health-card" aria-label={`${t.name} health`}>
      <div className="health-card-head">
        <div>
          <div className="health-card-name">{t.name}</div>
          <div className="health-card-desc">{t.description}</div>
        </div>
        <div className="health-badges">
          <HealthStatusBadge status={t.status} />
          <SourceBadge source={t.dataSource} note={t.note ?? undefined} />
        </div>
      </div>
      {t.note && <div className="health-note">{t.note}</div>}
      {t.configHint && <div className="health-hint">{t.configHint}</div>}
      {!waiting && (
        <>
          <div className="health-uptime">
            {(['24h', '7d', '30d'] as const).map((r) => {
              const u = uptimeLabel(t.uptime[r]);
              return (
                <div key={r} className="health-uptime-cell">
                  <div className="health-uptime-label">Uptime {r}</div>
                  <div className="health-uptime-value">{u.value}</div>
                  <div className="health-uptime-sub">{u.sub}</div>
                </div>
              );
            })}
          </div>
          <Sparkline points={t.series} label={t.name} />
          {t.error && <div className="health-error">{t.error}</div>}
          <div className="health-foot">
            <span>Last checked: {fmtTime(t.lastCheckedAt)}</span>
            <span>
              {t.latencyMs !== null ? `${t.latencyMs} ms` : 'no latency'}
              {t.httpStatus !== null ? ` · HTTP ${t.httpStatus}` : ''}
            </span>
          </div>
        </>
      )}
      <OpenAlerts counts={t.openAlerts} />
    </section>
  );
}

/** Compact one-line-per-target strip for the Dashboard. */
export function HealthStrip({ targets }: { targets: HealthTargetStatus[] }) {
  return (
    <div className="health-strip">
      {targets.map((t) => {
        const u = uptimeLabel(t.uptime['24h']);
        return (
          <Link key={t.id} to="/health" className="health-strip-item" aria-label={`${t.name}: ${LABEL[t.status]}`}>
            <span className="health-strip-name">{t.name}</span>
            <span className="health-badges">
              <HealthStatusBadge status={t.status} />
              <SourceBadge source={t.dataSource} note={t.note ?? undefined} />
            </span>
            <span className="health-strip-sub">
              {t.status === 'WAITING_FOR_INTEGRATION' ? 'Needs Urbani input' : `24h uptime ${u.value}${t.latencyMs !== null ? ` · ${t.latencyMs} ms` : ''}`}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
