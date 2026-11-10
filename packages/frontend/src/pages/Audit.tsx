import { Fragment, useState, type FormEvent } from 'react';
import { useApi } from '../hooks/useApi';
import { auditApi } from '../api/endpoints';
import {
  PageHeader, Card, FilterBar, Select, Input, Button, AsyncView, StatusBadge, fmtTime,
} from '../components/ui';

const EMPTY = { from: '', to: '', actor: '', action: '', result: '', category: '', text: '' };

/** Role recorded with the event (request context stored in metadata.ctx); legacy events have none. */
function roleOf(metadata: Record<string, unknown> | null): string {
  const ctx = metadata?.ctx as { role?: string } | undefined;
  return ctx?.role ?? '—';
}

/** Audit log (DPI 2 item 3). Append-only; viewing it is itself audited. Needs audit:view. */
export function Audit() {
  const [form, setForm] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  // Cursor stack: cursors[i] is the cursor used to load page i (page 0 has none).
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [open, setOpen] = useState<string | null>(null);
  const page = cursors.length - 1;

  const catalog = useApi(() => auditApi.actions(), []);
  const audit = useApi(
    () =>
      auditApi.search({
        ...applied,
        from: applied.from ? `${applied.from}T00:00:00.000Z` : undefined,
        to: applied.to ? `${applied.to}T23:59:59.999Z` : undefined,
        cursor: cursors[page],
      }),
    [applied, cursors],
  );

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const apply = (e: FormEvent) => {
    e.preventDefault();
    setCursors([undefined]);
    setApplied(form);
  };
  const reset = () => {
    setForm(EMPTY);
    setApplied(EMPTY);
    setCursors([undefined]);
  };

  return (
    <div className="stack">
      <PageHeader
        title="Audit log"
        subtitle="Append-only record of configuration changes and sensitive queries. Viewing this page is itself audited."
        source={(audit.data?.source ?? 'LIVE') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'}
      />
      <Card>
        <form onSubmit={apply}>
          <FilterBar>
            <Input type="date" aria-label="From date" value={form.from} onChange={set('from')} />
            <Input type="date" aria-label="To date" value={form.to} onChange={set('to')} />
            <Input type="search" placeholder="User email" aria-label="Filter by user email" value={form.actor} onChange={set('actor')} />
            <Select aria-label="Filter by action" value={form.action} onChange={set('action')}>
              <option value="">All actions</option>
              {(catalog.data?.data.actions ?? []).map((a) => (
                <option key={a.action} value={a.action}>{a.action}</option>
              ))}
            </Select>
            <Select aria-label="Filter by result" value={form.result} onChange={set('result')}>
              <option value="">All results</option>
              <option value="SUCCESS">SUCCESS</option>
              <option value="FAILURE">FAILURE</option>
              <option value="DENIED">DENIED</option>
            </Select>
            <Select aria-label="Filter by category" value={form.category} onChange={set('category')}>
              <option value="">All categories</option>
              <option value="CONFIG">CONFIG</option>
              <option value="SENSITIVE_QUERY">SENSITIVE_QUERY</option>
            </Select>
            <Input type="search" placeholder="Search target / details" aria-label="Free-text search" value={form.text} onChange={set('text')} />
            <Button type="submit" size="sm">Apply</Button>
            <Button type="button" size="sm" variant="ghost" onClick={reset}>Reset</Button>
          </FilterBar>
        </form>

        <AsyncView state={audit}>
          {(a) => a.data.items.length === 0 ? (
            <p className="text-secondary" style={{ padding: 'var(--space-4)' }}>No audit events match these filters.</p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Timestamp</th><th>User</th><th>Role</th><th>Action</th><th>Target</th><th>Result</th><th>Details</th></tr>
                  </thead>
                  <tbody>
                    {a.data.items.map((e) => (
                      <Fragment key={e.id}>
                        <tr>
                          <td>{fmtTime(e.timestamp)}</td>
                          <td>{e.actor}</td>
                          <td>{roleOf(e.metadata)}</td>
                          <td>{e.action}</td>
                          <td className="cell-mono">{e.target ?? '—'}</td>
                          <td><StatusBadge status={e.result} /></td>
                          <td>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-expanded={open === e.id}
                              onClick={() => setOpen(open === e.id ? null : e.id)}
                            >
                              {open === e.id ? 'Hide' : 'Show'}
                            </Button>
                          </td>
                        </tr>
                        {open === e.id && (
                          <tr>
                            <td colSpan={7}>
                              <pre className="audit-details">{JSON.stringify(e.metadata ?? {}, null, 2)}</pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="audit-pager">
                <span className="text-secondary">Page {page + 1}</span>
                <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!a.data.nextCursor}
                  onClick={() => setCursors([...cursors, a.data.nextCursor ?? undefined])}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
