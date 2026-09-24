import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { logsApi, servicesApi } from '../api/endpoints';
import {
  PageHeader, Card, FilterBar, SearchInput, Select, AsyncView, SkeletonTable, Pagination, fmtTime,
} from '../components/ui';

const PAGE_SIZE = 50;

const LEVEL_COLOR: Record<string, string> = {
  ERROR: 'var(--color-danger)', FATAL: 'var(--color-danger)',
  WARN: 'var(--color-warning)', INFO: 'var(--color-text-secondary)',
  DEBUG: 'var(--color-text-muted)',
};

/** Logs module (Part 20): light table, subtle monospace messages, filters. */
export function Logs() {
  const [service, setService] = useState('');
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const reset = () => setPage(1);

  const services = useApi(() => servicesApi.list(), []);
  const logs = useApi(() => logsApi.list({ service, level, search, page }), [service, level, search, page]);

  return (
    <div className="stack">
      <PageHeader
        title="Logs"
        subtitle="Log stream via the CloudWatch adapter boundary. Phase 1 uses seeded data."
        source="MOCK"
      />
      <Card>
        <FilterBar>
          <SearchInput placeholder="Search message…" value={search}
            onChange={(e) => { reset(); setSearch(e.target.value); }} aria-label="Search logs" />
          <Select value={level} onChange={(e) => { reset(); setLevel(e.target.value); }} aria-label="Filter by level">
            <option value="">All levels</option>
            <option>DEBUG</option><option>INFO</option><option>WARN</option><option>ERROR</option><option>FATAL</option>
          </Select>
          <Select value={service} onChange={(e) => { reset(); setService(e.target.value); }} aria-label="Filter by service">
            <option value="">All services</option>
            {services.data?.data.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </Select>
        </FilterBar>

        {logs.loading && !logs.data ? <SkeletonTable rows={10} cols={4} /> : (
          <AsyncView state={logs}>
            {(l) => l.data.items.length === 0 ? (
              <p className="text-secondary" style={{ padding: 'var(--space-4)' }}>No log entries match these filters.</p>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th style={{ width: 180 }}>Time</th><th style={{ width: 90 }}>Level</th><th style={{ width: 160 }}>Service</th><th>Message</th></tr></thead>
                    <tbody>
                      {l.data.items.map((e) => (
                        <tr key={e.id}>
                          <td>{fmtTime(e.timestamp)}</td>
                          <td style={{ color: LEVEL_COLOR[e.level] ?? 'inherit', fontWeight: 600 }}>{e.level}</td>
                          <td>{e.service}</td>
                          <td className="cell-mono">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} total={l.data.total} pageSize={PAGE_SIZE} onPage={setPage} />
              </>
            )}
          </AsyncView>
        )}
      </Card>
    </div>
  );
}
