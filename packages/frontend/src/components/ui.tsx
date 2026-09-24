import type { ReactNode } from 'react';
import type { DataSource, Severity } from '@urbani/shared';
import { SourceBadge } from './states';

/** Shared presentational helpers used across pages. */

export function PageHeader({
  title,
  subtitle,
  source,
  note,
  actions,
}: {
  title: string;
  subtitle?: string;
  source?: DataSource;
  note?: string;
  actions?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 20 }}>
      <div style={{ flex: 1 }}>
        <h1 className="page-title">
          {title}{' '}
          {source && <SourceBadge source={source} note={note} />}
        </h1>
        {subtitle && <p className="page-sub" style={{ margin: 0 }}>{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge sev-${severity}`}>{severity}</span>;
}

export function StatCard({ label, value, accent }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
    </div>
  );
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function Confidence({ value }: { value: number | null | undefined }) {
  if (value == null) return <>—</>;
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? 'var(--ok)' : pct >= 60 ? 'var(--warn)' : 'var(--bad)';
  return <span style={{ color, fontWeight: 600 }}>{pct}%</span>;
}
