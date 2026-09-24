import { Link } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import { dashboardApi, alertsApi, aiApi, usageApi } from '../api/endpoints';
import { AsyncView, SourceBadge } from '../components/states';
import { PageHeader, StatCard, SeverityBadge, fmtTime, Confidence } from '../components/ui';

/**
 * Dashboard overview (Epic 4). Answers the key questions: is the system healthy,
 * are there active incidents, which services, what evidence, what does AI say,
 * and what does it cost. All values are clearly MOCK-labelled in Phase 1.
 */
export function Dashboard() {
  const summary = useApi(() => dashboardApi.summary(), []);
  const health = useApi(() => dashboardApi.health(), []);
  const alerts = useApi(() => alertsApi.list({ pageSize: 5 }), []);
  const analyses = useApi(() => aiApi.list({ page: 1 }), []);
  const cost = useApi(() => usageApi.cost(), []);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Proactive observability overview — Phase 1 runs on controlled mock data."
        source="MOCK"
        note="Seeded demo data — not real AWS telemetry."
      />

      <div className="banner">
        <strong>Phase 1 (foundation).</strong> Values below are seeded demo data. Live AWS telemetry,
        CloudWatch logs/metrics, and Bedrock AI are wired behind adapter interfaces and activate in
        Phase 2/3. Data provenance is labelled everywhere as{' '}
        <SourceBadge source="LIVE" /> <SourceBadge source="MOCK" />{' '}
        <SourceBadge source="WAITING_FOR_INTEGRATION" />.
      </div>

      {/* TOP SUMMARY CARDS */}
      <AsyncView state={summary}>
        {(s) => (
          <div className="grid cards" style={{ marginBottom: 20 }}>
            <StatCard label="Total Services" value={s.data.totalServices} />
            <StatCard label="Active Alerts" value={s.data.activeAlerts} accent="var(--warn)" />
            <StatCard label="Critical Alerts" value={s.data.criticalAlerts} accent="var(--bad)" />
            <StatCard label="Recent Incidents" value={s.data.recentIncidents} />
            <StatCard label="AI Analyses" value={s.data.aiAnalyses} />
            <StatCard
              label="System Health"
              value={<span className={`status-${s.data.systemHealth}`}>{s.data.systemHealth}</span>}
            />
          </div>
        )}
      </AsyncView>

      <div className="grid two" style={{ marginBottom: 20 }}>
        {/* OBSERVABILITY AREA */}
        <div className="card">
          <h3>Observability — request latency (p95) & error rate</h3>
          <AsyncView state={health}>
            {(h) => {
              const chart = [...h.data.recentMetrics]
                .slice(0, 20)
                .reverse()
                .map((m) => ({
                  t: new Date(m.timestamp).toLocaleTimeString(),
                  latency: Math.round(m.latencyMsP95),
                  errorRate: Number(m.errorRate.toFixed(2)),
                }));
              return (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chart}>
                    <CartesianGrid stroke="#2a3346" strokeDasharray="3 3" />
                    <XAxis dataKey="t" stroke="#93a0b8" fontSize={11} />
                    <YAxis stroke="#93a0b8" fontSize={11} />
                    <Tooltip contentStyle={{ background: '#171d2b', border: '1px solid #2a3346' }} />
                    <Line type="monotone" dataKey="latency" stroke="#4f8cff" dot={false} />
                    <Line type="monotone" dataKey="errorRate" stroke="#f0883e" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              );
            }}
          </AsyncView>
        </div>

        {/* COST AREA */}
        <div className="card">
          <h3>AI Cost & Budget</h3>
          <AsyncView state={cost}>
            {(c) => (
              <div className="detail-grid">
                <div className="k">Daily cost</div>
                <div>${c.data.currentDailyCostUsd.toFixed(2)} / ${c.data.dailyBudgetUsd.toFixed(2)}</div>
                <div className="k">Monthly cost</div>
                <div>
                  ${c.data.currentMonthlyCostUsd.toFixed(2)} / ${c.data.monthlyBudgetUsd.toFixed(2)}
                </div>
                <div className="k">Soft / hard alert</div>
                <div>${c.data.softAlertUsd} / ${c.data.hardAlertUsd}</div>
                <div className="k">Budget status</div>
                <div className={`state-${c.data.state}`} style={{ fontWeight: 700 }}>
                  {c.data.state}
                </div>
              </div>
            )}
          </AsyncView>
          <p className="page-sub" style={{ marginTop: 12, fontSize: 12 }}>
            Cost control is a hard requirement (historical $5–6k spikes). Live billing integrates in
            Phase 2.
          </p>
        </div>
      </div>

      <div className="grid two">
        {/* ALERT AREA */}
        <div className="card">
          <h3>Recent Alerts</h3>
          <AsyncView state={alerts}>
            {(a) =>
              a.data.items.length === 0 ? (
                <div className="state">No alerts.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Service</th>
                      <th>Anomaly</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.data.items.map((al) => (
                      <tr key={al.alertId}>
                        <td><SeverityBadge severity={al.severity} /></td>
                        <td>
                          <Link to={`/alerts/${al.alertId}`}>{al.service}</Link>
                        </td>
                        <td>{al.anomalyType}</td>
                        <td>{al.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </AsyncView>
        </div>

        {/* AI AREA */}
        <div className="card">
          <h3>Recent AI Analyses</h3>
          <AsyncView state={analyses}>
            {(an) =>
              an.data.items.length === 0 ? (
                <div className="state">
                  No AI analyses yet. Trigger one from the AI Insights page.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Anomaly</th>
                      <th>Confidence</th>
                      <th>Model</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {an.data.items.slice(0, 5).map((a) => (
                      <tr key={a.id}>
                        <td>{a.service}</td>
                        <td>{a.anomalyType ?? 'NO_ANOMALY'}</td>
                        <td><Confidence value={a.confidence} /></td>
                        <td className="mono" style={{ fontSize: 11 }}>{a.modelId}</td>
                        <td>{fmtTime(a.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </AsyncView>
        </div>
      </div>
    </div>
  );
}
