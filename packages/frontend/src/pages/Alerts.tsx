import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { alertsApi, servicesApi } from '../api/endpoints';
import { AsyncView, SkeletonRows } from '../components/states';
import { PageHeader, SeverityBadge, Confidence, fmtTime } from '../components/ui';

/** Alerts / Incidents list (Epic 5) with filtering, search and pagination. */
export function Alerts() {
  const navigate = useNavigate();
  const [severity, setSeverity] = useState('');
  const [service, setService] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const services = useApi(() => servicesApi.list(), []);
  const alerts = useApi(
    () => alertsApi.list({ severity, service, status, search, page, pageSize: 15 }),
    [severity, service, status, search, page],
  );

  const pageSize = 15;

  return (
    <div>
      <PageHeader
        title="Alerts / Incidents"
        subtitle="Advisory, human-in-the-loop. No automated remediation is ever performed."
        source="MOCK"
      />

      <div className="filters">
        <input
          placeholder="Search summary / cause…"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
        <select value={severity} onChange={(e) => { setPage(1); setSeverity(e.target.value); }}>
          <option value="">All severities</option>
          <option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option>
        </select>
        <select value={service} onChange={(e) => { setPage(1); setService(e.target.value); }}>
          <option value="">All services</option>
          {services.data?.data.map((s) => (
            <option key={s.id} value={s.name}>{s.name}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
          <option value="">All statuses</option>
          <option>OPEN</option><option>ACKNOWLEDGED</option><option>RESOLVED</option><option>DISMISSED</option>
        </select>
      </div>

      <div className="card">
        {alerts.loading && !alerts.data ? (
          <SkeletonRows rows={8} cols={7} />
        ) : (
          <AsyncView state={alerts}>
            {(a) =>
              a.data.items.length === 0 ? (
                <div className="state">No alerts match these filters.</div>
              ) : (
                <>
                  <table>
                    <thead>
                      <tr>
                        <th>Alert ID</th>
                        <th>Time</th>
                        <th>Service</th>
                        <th>Env</th>
                        <th>Severity</th>
                        <th>Anomaly</th>
                        <th>Confidence</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.data.items.map((al) => (
                        <tr key={al.alertId} onClick={() => navigate(`/alerts/${al.alertId}`)}>
                          <td className="mono">{al.alertId}</td>
                          <td>{fmtTime(al.timestamp)}</td>
                          <td>{al.service}</td>
                          <td>{al.environment}</td>
                          <td><SeverityBadge severity={al.severity} /></td>
                          <td>{al.anomalyType}</td>
                          <td><Confidence value={al.confidence} /></td>
                          <td>{al.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pagination page={page} total={a.data.total} pageSize={pageSize} onPage={setPage} />
                </>
              )
            }
          </AsyncView>
        )}
      </div>
    </div>
  );
}

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
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
      <button className="btn secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Prev
      </button>
      <span style={{ color: 'var(--text-dim)' }}>
        Page {page} of {pages} · {total} total
      </span>
      <button className="btn secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}
