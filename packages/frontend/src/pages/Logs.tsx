import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { logsApi, servicesApi } from '../api/endpoints';
import { AsyncView, SkeletonRows } from '../components/states';
import { PageHeader, fmtTime } from '../components/ui';
import { Pagination } from './Alerts';

/** Logs module (Epic 6). Mock/seed log stream with search + filters. */
export function Logs() {
  const [service, setService] = useState('');
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const services = useApi(() => servicesApi.list(), []);
  const logs = useApi(
    () => logsApi.list({ service, level, search, page }),
    [service, level, search, page],
  );

  return (
    <div>
      <PageHeader
        title="Logs"
        subtitle="Log stream via the CloudWatch adapter boundary. Phase 1 = seeded data."
        source="MOCK"
      />
      <div className="filters">
        <input
          placeholder="Search message…"
          value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }}
        />
        <select value={level} onChange={(e) => { setPage(1); setLevel(e.target.value); }}>
          <option value="">All levels</option>
          <option>DEBUG</option><option>INFO</option><option>WARN</option><option>ERROR</option><option>FATAL</option>
        </select>
        <select value={service} onChange={(e) => { setPage(1); setService(e.target.value); }}>
          <option value="">All services</option>
          {services.data?.data.map((s) => (
            <option key={s.id} value={s.name}>{s.name}</option>
          ))}
        </select>
      </div>

      <div className="card">
        {logs.loading && !logs.data ? (
          <SkeletonRows rows={10} cols={4} />
        ) : (
          <AsyncView state={logs}>
            {(l) =>
              l.data.items.length === 0 ? (
                <div className="state">No log entries match these filters.</div>
              ) : (
                <>
                  <table>
                    <thead>
                      <tr><th>Time</th><th>Level</th><th>Service</th><th>Message</th></tr>
                    </thead>
                    <tbody>
                      {l.data.items.map((entry) => (
                        <tr key={entry.id} style={{ cursor: 'default' }}>
                          <td>{fmtTime(entry.timestamp)}</td>
                          <td>
                            <span
                              style={{
                                color:
                                  entry.level === 'ERROR' || entry.level === 'FATAL'
                                    ? 'var(--bad)'
                                    : entry.level === 'WARN'
                                      ? 'var(--warn)'
                                      : 'var(--text-dim)',
                                fontWeight: 600,
                              }}
                            >
                              {entry.level}
                            </span>
                          </td>
                          <td>{entry.service}</td>
                          <td className="mono">{entry.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pagination page={page} total={l.data.total} pageSize={50} onPage={setPage} />
                </>
              )
            }
          </AsyncView>
        )}
      </div>
    </div>
  );
}
