import type { ReactNode } from 'react';
import type { DataSource } from '@urbani/shared';

/** Reusable loading / empty / error / skeleton states (Epic 3 + UX section). */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="state">{label}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state error">
      <div>⚠ {message}</div>
      {onRetry && (
        <button className="btn secondary" style={{ marginTop: 12 }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ message = 'Nothing to show yet.' }: { message?: string }) {
  return <div className="state">{message}</div>;
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <table>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r}>
            {Array.from({ length: cols }).map((_, c) => (
              <td key={c}>
                <div className="skeleton" style={{ height: 14, width: `${60 + ((c * 13) % 40)}%` }} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Provenance badge — makes LIVE vs MOCK vs WAITING explicit everywhere. */
export function SourceBadge({ source, note }: { source: DataSource; note?: string }) {
  const label = source === 'WAITING_FOR_INTEGRATION' ? 'WAITING' : source;
  return (
    <span className={`src src-${source}`} title={note ?? source}>
      {label}
    </span>
  );
}

/** Convenience wrapper: renders the right state or the children with data. */
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
