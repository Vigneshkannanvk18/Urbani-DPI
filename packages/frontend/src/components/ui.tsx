import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from 'react';
import type { DataSource, Severity } from '@urbani/shared';
import { IconSearch, IconInbox, IconWarn, IconChevronLeft, IconChevronRight } from './icons';

/* ============================================================================
   Reusable component system (Part 29). Token-driven; no page redefines styles.
   ============================================================================ */

/* ---------- Button ---------- */
type BtnVariant = 'primary' | 'secondary' | 'ghost';
export function Button({
  variant = 'primary',
  size,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' }) {
  return (
    <button className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/* ---------- Input / SearchInput / Select ---------- */
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function SearchInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="input-search">
      <span className="search-icon"><IconSearch size={16} /></span>
      <input className="input" type="search" {...props} />
    </div>
  );
}

export function Select({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className="select" {...rest}>
      {children}
    </select>
  );
}

/* ---------- Card / MetricCard ---------- */
export function Card({
  title,
  titleSub,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  titleSub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-title">
          <span>
            {title} {titleSub && <span className="card-title-sub">{titleSub}</span>}
          </span>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  foot,
  icon,
  accent,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  icon?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="card metric-card">
      <div className="metric-head">
        {icon && <span className={`metric-icon ${accent ? 'accent' : ''}`}>{icon}</span>}
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-value">{value}</div>
      {foot && <div className="metric-foot">{foot}</div>}
    </div>
  );
}

/* ---------- Badges ---------- */
export function SeverityBadge({ severity }: { severity: Severity }) {
  // Not color-only (Part 28): includes a dot + the text label.
  return (
    <span className={`badge sev-${severity}`}>
      <span className="badge-dot" aria-hidden />
      {severity}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge st-${status}`}>
      <span className="badge-dot" aria-hidden />
      {status}
    </span>
  );
}

export function SourceBadge({ source, note }: { source: DataSource; note?: string }) {
  const label = source === 'WAITING_FOR_INTEGRATION' ? 'WAITING' : source;
  return (
    <span className={`src src-${source}`} title={note ?? source}>
      {label}
    </span>
  );
}

/* ---------- Page header / section header / filter bar ---------- */
export function PageHeader({
  title,
  subtitle,
  source,
  note,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  source?: DataSource;
  note?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        <h1 className="page-title">
          {title}
          {source && <SourceBadge source={source} note={note} />}
        </h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="row gap-2 wrap">{actions}</div>}
    </header>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}

/* ---------- States ---------- */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="state">{label}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state error">
      <div className="state-icon"><IconWarn size={28} /></div>
      <div>{message}</div>
      {onRetry && (
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
        </div>
      )}
    </div>
  );
}

export function EmptyState({ message = 'Nothing to show yet.' }: { message?: string }) {
  return (
    <div className="state">
      <div className="state-icon"><IconInbox size={28} /></div>
      <div>{message}</div>
    </div>
  );
}

export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <table className="data">
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r}>
            {Array.from({ length: cols }).map((_, c) => (
              <td key={c}>
                <div className="skeleton" style={{ height: 14, width: `${55 + ((c * 11) % 40)}%` }} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AsyncView<T>({
  state,
  children,
}: {
  state: { data: T | null; loading: boolean; error: string | null; reload: () => void };
  children: (data: T) => ReactNode;
}) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data) return <EmptyState />;
  return <>{children(state.data)}</>;
}

/* ---------- Pagination ---------- */
export function Pagination({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  return (
    <div className="pagination">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <IconChevronLeft size={16} /> Prev
      </Button>
      <span className="page-info">Page {page} of {pages} · {total} total</span>
      <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
        Next <IconChevronRight size={16} />
      </Button>
    </div>
  );
}

/* ---------- Display helpers ---------- */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function Confidence({ value }: { value: number | null | undefined }) {
  if (value == null) return <>—</>;
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? 'var(--color-success)' : pct >= 60 ? 'var(--color-warning)' : 'var(--color-danger)';
  return <span style={{ color, fontWeight: 600 }}>{pct}%</span>;
}
