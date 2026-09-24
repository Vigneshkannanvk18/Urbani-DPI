import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import { metricsApi, servicesApi } from '../api/endpoints';
import { PageHeader, Card, MetricCard, FilterBar, Select, AsyncView } from '../components/ui';
import { CHART, chartAxisProps, chartTooltipStyle } from '../components/chart';

/** Metrics module (Part 21): current-value cards + restrained time-series charts. */
export function Metrics() {
  const [service, setService] = useState('');
  const services = useApi(() => servicesApi.list(), []);
  const metrics = useApi(() => metricsApi.list({ service }), [service]);

  return (
    <div className="stack">
      <PageHeader
        title="Metrics"
        subtitle="Performance metrics via the CloudWatch Metrics adapter boundary. Phase 1 uses seeded data."
        source="MOCK"
      />
      <FilterBar>
        <Select value={service} onChange={(e) => setService(e.target.value)} aria-label="Filter by service">
          <option value="">All services</option>
          {services.data?.data.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </Select>
      </FilterBar>

      <AsyncView state={metrics}>
        {(m) => {
          const latest = m.data[0];
          const chart = [...m.data].slice(0, 24).reverse().map((x) => ({
            t: new Date(x.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            cpu: Math.round(x.cpuPercent),
            memory: Math.round(x.memoryPercent),
            latency: Math.round(x.latencyMsP95),
            errorRate: Number(x.errorRate.toFixed(2)),
            requests: x.requestCount,
            http5xx: x.http5xxCount,
          }));
          const total5xx = m.data.reduce((n, x) => n + x.http5xxCount, 0);
          const restarts = m.data.reduce((n, x) => n + x.instanceRestarts, 0);

          return (
            <>
              <div className="grid kpi">
                <MetricCard label="CPU" value={`${Math.round(latest?.cpuPercent ?? 0)}%`} />
                <MetricCard label="Memory" value={`${Math.round(latest?.memoryPercent ?? 0)}%`} />
                <MetricCard label="Error Rate" value={`${(latest?.errorRate ?? 0).toFixed(1)}%`} accent />
                <MetricCard label="Request Count" value={(latest?.requestCount ?? 0).toLocaleString()} />
                <MetricCard label="Latency p95" value={`${Math.round(latest?.latencyMsP95 ?? 0)} ms`} />
                <MetricCard label="HTTP 5xx" value={total5xx} />
                <MetricCard label="Instance Restarts" value={restarts} />
                <MetricCard label="Samples" value={m.data.length} />
              </div>

              <div className="grid two">
                <ChartCard title="CPU % / Memory %" data={chart} series={[['cpu', CHART.primary], ['memory', CHART.info]]} />
                <ChartCard title="Latency p95 (ms)" data={chart} series={[['latency', CHART.primary]]} />
                <ChartCard title="Error rate (%)" data={chart} series={[['errorRate', CHART.danger]]} />
                <ChartCard title="Requests / HTTP 5xx" data={chart} series={[['requests', CHART.info], ['http5xx', CHART.danger]]} />
              </div>
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}

function ChartCard({
  title, data, series,
}: {
  title: string;
  data: Array<Record<string, string | number>>;
  series: Array<[string, string]>;
}) {
  return (
    <Card title={title}>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="t" {...chartAxisProps} />
          <YAxis {...chartAxisProps} />
          <Tooltip contentStyle={chartTooltipStyle} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
          {series.map(([key, color]) => (
            <Line key={key} type="monotone" dataKey={key} stroke={color} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}
