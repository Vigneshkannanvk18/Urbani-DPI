import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { alertsApi, servicesApi } from '../api/endpoints';
import {
  PageHeader, Card, FilterBar, SearchInput, Select, SeverityBadge, StatusBadge,
  Confidence, fmtTime, AsyncView, SkeletonTable, Pagination,
} from '../components/ui';

const PAGE_SIZE = 15;

/** Alerts / Incidents list (Part 18): search, severity/service/status filters,
 *  pagination, row hover, accessible severity badges. */
export function Alerts() {
  const navigate = useNavigate();
  const [severity, setSeverity] = useState('');
  const [service, setService] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const services = useApi(() => servicesApi.list(), []);
  const alerts = useApi(
    () => alertsApi.list({ severity, service, status, search, page, pageSize: PAGE_SIZE }),
    [severity, service, status, search, page],
  );

  const reset = () => setPage(1);

  return (
    <div className="stack">
      <PageHeader
        title="Alerts / Incidents"
        subtitle="Advisory, human-in-the-loop. No automated remediation is ever performed."
        source={(alerts.data?.source ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'}
      />

      <Card>
        <FilterBar>
          <SearchInput
            placeholder="Search summary or cause…"
            value={search}
            onChange={(e) => { reset(); setSearch(e.target.value); }}
            aria-label="Search alerts"
          />
          <Select value={severity} onChange={(e) => { reset(); setSeverity(e.target.value); }} aria-label="Filter by severity">
            <option value="">All severities</option>
            <option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option>
          </Select>
          <Select value={service} onChange={(e) => { reset(); setService(e.target.value); }} aria-label="Filter by service">
            <option value="">All services</option>
            {services.data?.data.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </Select>
          <Select value={status} onChange={(e) => { reset(); setStatus(e.target.value); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option>OPEN</option><option>ACKNOWLEDGED</option><option>RESOLVED</option><option>DISMISSED</option>
          </Select>
        </FilterBar>

        {alerts.loading && !alerts.data ? (
          <SkeletonTable rows={8} cols={7} />
        ) : (
          <AsyncView state={alerts}>
            {(a) => a.data.items.length === 0 ? (
              <p className="text-secondary" style={{ padding: 'var(--space-4)' }}>No alerts match these filters.</p>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Alert ID</th><th>Time</th><th>Service</th><th>Env</th>
                        <th>Severity</th><th>Anomaly</th><th>Confidence</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.data.items.map((al) => (
                        <tr key={al.alertId} className="clickable" onClick={() => navigate(`/alerts/${al.alertId}`)}>
                          <td className="cell-mono">{al.alertId}</td>
                          <td>{fmtTime(al.timestamp)}</td>
                          <td>{al.service}</td>
                          <td>{al.environment}</td>
                          <td><SeverityBadge severity={al.severity} /></td>
                          <td>{al.anomalyType}</td>
                          <td><Confidence value={al.confidence} /></td>
                          <td><StatusBadge status={al.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} total={a.data.total} pageSize={PAGE_SIZE} onPage={setPage} />
              </>
            )}
          </AsyncView>
        )}
      </Card>
    </div>
  );
}
