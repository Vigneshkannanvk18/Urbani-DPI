import { Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import { dashboardApi, alertsApi, aiApi, usageApi } from '../api/endpoints';
import {
  PageHeader, Card, MetricCard, AsyncView, SeverityBadge, StatusBadge, Confidence, fmtTime,
} from '../components/ui';
import {
  IconServices, IconAlert, IconWarn, IconActivity, IconAI, IconServer,
} from '../components/icons';
import { CHART, chartAxisProps, chartTooltipStyle } from '../components/chart';

/** Dashboard overview (Parts 14–17). Light theme, KPI cards, system health,
 *  observability chart, AI cost/budget — all clearly MOCK-labelled in Phase 1. */
export function Dashboard() {
  const summary = useApi(() => dashboardApi.summary(), []);
  const health = useApi(() => dashboardApi.health(), []);
  const alerts = useApi(() => alertsApi.list({ pageSize: 5 }), []);
  const analyses = useApi(() => aiApi.list({ page: 1 }), []);
  const cost = useApi(() => usageApi.cost(), []);

  const s = summary.data?.data;
  const healthState = s?.systemHealth ?? 'UNKNOWN';

  return (
    <div className="stack">
      <PageHeader
        title="Dashboard"
        subtitle="Proactive observability overview"
        source={(summary.data?.source ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'}
      />

      <div className="banner">
        <span className="banner-icon"><IconWarn size={16} /></span>
        <span>
          <strong>Mixed data sources.</strong> Logs, alerts, and the AI assistant are
          live from the Urbani AWS backend (Bedrock Nova Lite). Metrics, services, usage,
          and audit remain seeded until their AWS endpoints are provided. Every panel is
          labelled with its true source: <span className="src src-LIVE">LIVE</span>{' '}
          <span className="src src-MOCK">MOCK</span> <span className="src src-WAITING_FOR_INTEGRATION">WAITING</span>.
        </span>
      </div>

      {/* KPI cards */}
      <AsyncView state={summary}>
        {(res) => (
          <div className="grid kpi">
            <MetricCard label="Total Services" value={res.data.totalServices} icon={<IconServices size={18} />} />
            <MetricCard label="Active Alerts" value={res.data.activeAlerts} accent icon={<IconAlert size={18} />} foot="Open + acknowledged" />
            <MetricCard label="Critical Alerts" value={res.data.criticalAlerts} icon={<IconWarn size={18} />} foot="Require attention" />
            <MetricCard label="Recent Incidents" value={res.data.recentIncidents} icon={<IconActivity size={18} />} />
            <MetricCard label="AI Analyses" value={res.data.aiAnalyses} icon={<IconAI size={18} />} />
            <MetricCard
              label="System Health"
              value={<StatusBadge status={healthState} />}
              icon={<IconServer size={18} />}
            />
          </div>
        )}
      </AsyncView>

      <div className="grid two">
        {/* System Health */}
        <Card title="System Health">
          <AsyncView state={health}>
            {(h) => {
              const monitored = h.data.services.length;
              const degraded = h.data.services.filter((x) => x.status === 'DEGRADED').length;
              const down = h.data.services.filter((x) => x.status === 'DOWN').length;
              return (
                <div>
                  <div className="row" style={{ marginBottom: 'var(--space-4)' }}>
                    <StatusBadge status={healthState} />
                    <span className="text-secondary" style={{ fontSize: 13 }}>
                      {healthState === 'HEALTHY' ? 'All systems operating normally' :
                        healthState === 'DEGRADED' ? 'Some services need attention' :
                        healthState === 'DOWN' ? 'Service outage detected' : 'Status unknown'}
                    </span>
                  </div>
                  <div className="detail-grid">
                    <div className="k">Services monitored</div><div>{monitored}</div>
                    <div className="k">Degraded</div><div>{degraded}</div>
                    <div className="k">Down</div><div>{down}</div>
                    <div className="k">Critical alerts</div><div>{s?.criticalAlerts ?? 0}</div>
                    <div className="k">Active incidents</div><div>{s?.activeAlerts ?? 0}</div>
                  </div>
                </div>
              );
            }}
          </AsyncView>
        </Card>

        {/* AI Cost & Budget */}
        <Card title="AI Cost & Budget" titleSub="MOCK — not live billing">
          <AsyncView state={cost}>
            {(c) => {
              const label = c.data.state === 'OK' ? 'Within budget'
                : c.data.state === 'APPROACHING' ? 'Approaching limit' : 'Over budget';
              return (
                <div>
                  <div className="row" style={{ marginBottom: 'var(--space-4)' }}>
                    <StatusBadge status={c.data.state} />
                    <span className="text-secondary" style={{ fontSize: 13 }}>{label}</span>
                  </div>
                  <div className="detail-grid">
                    <div className="k">Daily cost</div><div>${c.data.currentDailyCostUsd.toFixed(2)} / ${c.data.dailyBudgetUsd.toFixed(2)}</div>
                    <div className="k">Monthly cost</div><div>${c.data.currentMonthlyCostUsd.toFixed(2)} / ${c.data.monthlyBudgetUsd.toFixed(2)}</div>
                    <div className="k">Soft alert</div><div>${c.data.softAlertUsd.toFixed(2)}</div>
                    <div className="k">Hard alert</div><div>${c.data.hardAlertUsd.toFixed(2)}</div>
                  </div>
                </div>
              );
            }}
          </AsyncView>
        </Card>
      </div>

      {/* Observability chart */}
      <Card title="Observability" titleSub="Latency p95 (ms) & error rate (%)">
        <AsyncView state={health}>
          {(h) => {
            const data = [...h.data.recentMetrics].slice(0, 20).reverse().map((m) => ({
              t: new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              latency: Math.round(m.latencyMsP95),
              errorRate: Number(m.errorRate.toFixed(2)),
            }));
            return (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="t" {...chartAxisProps} />
                  <YAxis {...chartAxisProps} />
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" name="Latency p95" dataKey="latency" stroke={CHART.primary} strokeWidth={2} dot={false} />
                  <Line type="monotone" name="Error rate" dataKey="errorRate" stroke={CHART.info} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            );
          }}
        </AsyncView>
      </Card>

      <div className="grid two">
        {/* Recent alerts */}
        <Card title="Recent Alerts" actions={<Link to="/alerts">View all</Link>}>
          <AsyncView state={alerts}>
            {(a) => a.data.items.length === 0 ? <p className="text-secondary">No alerts.</p> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Severity</th><th>Service</th><th>Anomaly</th><th>Status</th></tr></thead>
                  <tbody>
                    {a.data.items.map((al) => (
                      <tr key={al.alertId} className="clickable">
                        <td><SeverityBadge severity={al.severity} /></td>
                        <td><Link to={`/alerts/${al.alertId}`}>{al.service}</Link></td>
                        <td>{al.anomalyType}</td>
                        <td><StatusBadge status={al.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </Card>

        {/* Recent AI analyses */}
        <Card title="Recent AI Analyses" actions={<Link to="/ai">View all</Link>}>
          <AsyncView state={analyses}>
            {(an) => an.data.items.length === 0 ? (
              <p className="text-secondary">No analyses yet. Trigger one from AI Insights.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Service</th><th>Anomaly</th><th>Conf.</th><th>Time</th></tr></thead>
                  <tbody>
                    {an.data.items.slice(0, 5).map((a) => (
                      <tr key={a.id}>
                        <td>{a.service}</td>
                        <td>{a.anomalyType ?? <span className="text-muted">NO_ANOMALY</span>}</td>
                        <td><Confidence value={a.confidence} /></td>
                        <td className="cell-mono">{fmtTime(a.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </Card>
      </div>
    </div>
  );
}
