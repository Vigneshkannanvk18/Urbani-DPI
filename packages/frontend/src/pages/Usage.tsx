import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import { usageApi } from '../api/endpoints';
import { PageHeader, Card, MetricCard, StatusBadge, AsyncView, fmtTime } from '../components/ui';
import { CHART, chartAxisProps, chartTooltipStyle } from '../components/chart';

/** Usage & Cost (Part 24). Cost control is a hard requirement (historical $5–6k
 *  spikes). Clearly MOCK — never fabricate live billing. */
export function Usage() {
  const usage = useApi(() => usageApi.usage(), []);
  const cost = useApi(() => usageApi.cost(), []);

  return (
    <div className="stack">
      <PageHeader
        title="Usage & Cost"
        subtitle="AI request / token / cost tracking with budget guardrails. Live AWS billing integrates in a later phase."
        source={(usage.data?.source ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'}
      />

      <AsyncView state={cost}>
        {(c) => (
          <div className="grid kpi">
            <MetricCard label="Daily Cost" value={`$${c.data.currentDailyCostUsd.toFixed(2)}`} accent foot={`Budget $${c.data.dailyBudgetUsd.toFixed(2)}`} />
            <MetricCard label="Monthly Cost" value={`$${c.data.currentMonthlyCostUsd.toFixed(2)}`} foot={`Budget $${c.data.monthlyBudgetUsd.toFixed(2)}`} />
            <MetricCard label="Soft Alert" value={`$${c.data.softAlertUsd.toFixed(0)}`} />
            <MetricCard label="Hard Alert" value={`$${c.data.hardAlertUsd.toFixed(0)}`} />
            <MetricCard label="Budget Status" value={<StatusBadge status={c.data.state} />} />
          </div>
        )}
      </AsyncView>

      <AsyncView state={usage}>
        {(u) => {
          const chart = [...u.data.records].reverse().map((r) => ({
            date: r.date.slice(5), cost: r.estimatedCostUsd, requests: r.aiRequestCount,
          }));
          return (
            <div className="grid two">
              <Card title="Estimated daily AI cost" titleSub="USD (mock)">
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chart} margin={{ left: -10, right: 8, top: 8 }}>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="date" {...chartAxisProps} />
                    <YAxis {...chartAxisProps} />
                    <Tooltip contentStyle={chartTooltipStyle} />
                    <Bar dataKey="cost" fill={CHART.primary} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Usage totals & model breakdown">
                <div className="detail-grid">
                  <div className="k">AI requests</div><div>{u.data.totals.requests.toLocaleString()}</div>
                  <div className="k">Input tokens</div><div>{u.data.totals.inputTokens.toLocaleString()}</div>
                  <div className="k">Output tokens</div><div>{u.data.totals.outputTokens.toLocaleString()}</div>
                  <div className="k">Est. total cost</div><div>${u.data.totals.costUsd.toFixed(2)}</div>
                </div>
                <h3 className="section-title mt-4" style={{ fontSize: 'var(--text-card)' }}>Daily records</h3>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Date</th><th>Model</th><th>Requests</th><th>Cost</th></tr></thead>
                    <tbody>
                      {u.data.records.map((r) => (
                        <tr key={r.id}>
                          <td>{fmtTime(r.date)}</td>
                          <td className="cell-mono">{r.modelId}</td>
                          <td>{r.aiRequestCount}</td>
                          <td>${r.estimatedCostUsd.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          );
        }}
      </AsyncView>
    </div>
  );
}
