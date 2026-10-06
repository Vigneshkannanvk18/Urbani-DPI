import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { auditApi } from '../api/endpoints';
import {
  PageHeader, Card, FilterBar, Select, AsyncView, Pagination, fmtTime,
} from '../components/ui';

const PAGE_SIZE = 50;

/** Audit / Activity (Part 25). App-level events; Phase 2 adds CloudTrail. */
export function Audit() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const audit = useApi(() => auditApi.list({ action, page }), [action, page]);

  return (
    <div className="stack">
      <PageHeader
        title="Audit / Activity"
        subtitle="Application-level audit trail. AWS CloudTrail integration is planned for a later phase."
        source={(audit.data?.source ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'}
      />
      <Card>
        <FilterBar>
          <Select value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} aria-label="Filter by action">
            <option value="">All actions</option>
            <option>LOGIN</option><option>LOGOUT</option><option>ALERT_VIEWED</option>
            <option>ALERT_ACKNOWLEDGED</option><option>CONFIG_CHANGED</option><option>INTEGRATION_UPDATED</option>
          </Select>
        </FilterBar>

        <AsyncView state={audit}>
          {(a) => a.data.items.length === 0 ? (
            <p className="text-secondary" style={{ padding: 'var(--space-4)' }}>No audit events recorded yet.</p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Resource</th></tr></thead>
                  <tbody>
                    {a.data.items.map((e) => (
                      <tr key={e.id}>
                        <td>{fmtTime(e.timestamp)}</td>
                        <td>{e.actor}</td>
                        <td>{e.action}</td>
                        <td className="cell-mono">{e.target ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={page} total={a.data.total} pageSize={PAGE_SIZE} onPage={setPage} />
            </>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
