import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { auditApi } from '../api/endpoints';
import { AsyncView } from '../components/states';
import { PageHeader, fmtTime } from '../components/ui';
import { Pagination } from './Alerts';

/** Audit / Activity (Epic 11). App-level events; Phase 2 adds CloudTrail. */
export function Audit() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const audit = useApi(() => auditApi.list({ action, page }), [action, page]);

  return (
    <div>
      <PageHeader
        title="Audit / Activity"
        subtitle="Application-level audit trail. AWS CloudTrail integration is planned for Phase 2."
        source="MOCK"
      />
      <div className="filters">
        <select value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }}>
          <option value="">All actions</option>
          <option>LOGIN</option><option>LOGOUT</option><option>ALERT_VIEWED</option>
          <option>ALERT_ACKNOWLEDGED</option><option>CONFIG_CHANGED</option><option>INTEGRATION_UPDATED</option>
        </select>
      </div>
      <div className="card">
        <AsyncView state={audit}>
          {(a) =>
            a.data.items.length === 0 ? (
              <div className="state">No audit events recorded yet.</div>
            ) : (
              <>
                <table>
                  <thead>
                    <tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr>
                  </thead>
                  <tbody>
                    {a.data.items.map((e) => (
                      <tr key={e.id} style={{ cursor: 'default' }}>
                        <td>{fmtTime(e.timestamp)}</td>
                        <td>{e.actor}</td>
                        <td>{e.action}</td>
                        <td className="mono">{e.target ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pagination page={page} total={a.data.total} pageSize={50} onPage={setPage} />
              </>
            )
          }
        </AsyncView>
      </div>
    </div>
  );
}
