import { useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import { metricsApi, servicesApi } from '../api/endpoints';
import { AsyncView } from '../components/states';
import { PageHeader } from '../components/ui';

/** Metrics module (Epic 7). Seed CPU/memory/error/latency/5xx/restart data. */
export function Metrics() {
  const [service, setService] = useState('');
  const services = useApi(() => servicesApi.list(), []);
  const metrics = useApi(() => metricsApi.list({ service }), [service]);

  return (
    <div>
      <PageHeader
        title="Metrics"
        subtitle="Performance metrics via the CloudWatch Metrics adapter boundary. Phase 1 = seeded data."
        source="MOCK"
      />
      <div className="filters">
        <select value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">All services</option>
          {services.data?.data.map((s) => (
            <option key={s.id} value={s.name}>{s.name}</option>
          ))}
        </select>
      </div>

      <AsyncView state={metrics}>
        {(m) => {
          const chart = [...m.data]
            .slice(0, 24)
            .reverse()
            .map((x) => ({
              t: new Date(x.timestamp).toLocaleTimeString(),
              cpu: Math.round(x.cpuPercent),
              memory: Math.round(x.memoryPercent),
              latency: Math.round(x.latencyMsP95),
              errorRate: Number(x.errorRate.toFixed(2)),
              http5xx: x.http5xxCount,
              requests: x.requestCount,
              restarts: x.instanceRestarts,
            }));

          const totalRestarts = m.data.reduce((n, x) => n + x.instanceRestarts, 0);
          const total5xx = m.data.reduce((n, x) => n + x.http5xxCount, 0);

          return (
            <>
              <div className="grid cards" style={{ marginBottom: 16 }}>
                <div className="card stat"><div className="label">Samples</div><div className="value">{m.data.length}</div></div>
                <div className="card stat"><div className="label">Total 5xx</div><div className="value" style={{ color: 'var(--bad)' }}>{total5xx}</div></div>
                <div className="card stat"><div className="label">Instance restarts</div><div className="value">{totalRestarts}</div></div>
              </div>

              <div className="grid two">
                <MetricChart title="CPU % / Memory %" data={chart} lines={[['cpu', '#4f8cff'], ['memory', '#3fb950']]} />
                <MetricChart title="Latency p95 (ms)" data={chart} lines={[['latency', '#f0883e']]} />
                <MetricChart title="Error rate %" data={chart} lines={[['errorRate', '#f85149']]} />
                <MetricChart title="Requests / HTTP 5xx" data={chart} lines={[['requests', '#4f8cff'], ['http5xx', '#f85149']]} />
              </div>
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}

function MetricChart({
  title,
  data,
  lines,
}: {
  title: string;
  data: Array<Record<string, string | number>>;
  lines: Array<[string, string]>;
}) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <CartesianGrid stroke="#2a3346" strokeDasharray="3 3" />
          <XAxis dataKey="t" stroke="#93a0b8" fontSize={11} />
          <YAxis stroke="#93a0b8" fontSize={11} />
          <Tooltip contentStyle={{ background: '#171d2b', border: '1px solid #2a3346' }} />
          <Legend />
          {lines.map(([key, color]) => (
            <Line key={key} type="monotone" dataKey={key} stroke={color} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
