import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import { usageApi } from '../api/endpoints';
import { AsyncView } from '../components/states';
import { PageHeader, StatCard, fmtTime } from '../components/ui';

/**
 * Usage & Cost (Epic 10). Cost control is a hard requirement (historical $5–6k
 * spikes). Values are clearly MOCK — never fabricate live billing.
 */
export function Usage() {
  const usage = useApi(() => usageApi.usage(), []);
  const cost = useApi(() => usageApi.cost(), []);

  return (
    <div>
      <PageHeader
        title="Usage & Cost"
        subtitle="AI request/token/cost tracking with budget guardrails. Live AWS billing integrates in Phase 2."
        source="MOCK"
      />

      <AsyncView state={cost}>
        {(c) => (
          <div className="grid cards" style={{ marginBottom: 16 }}>
            <StatCard label="Daily cost" value={`$${c.data.currentDailyCostUsd.toFixed(2)}`} />
            <StatCard label="Daily budget" value={`$${c.data.dailyBudgetUsd.toFixed(2)}`} />
            <StatCard label="Monthly cost" value={`$${c.data.currentMonthlyCostUsd.toFixed(2)}`} />
            <StatCard label="Monthly budget" value={`$${c.data.monthlyBudgetUsd.toFixed(2)}`} />
            <StatCard
              label="Budget status"
              value={<span className={`state-${c.data.state}`}>{c.data.state}</span>}
            />
          </div>
        )}
      </AsyncView>

      <AsyncView state={usage}>
        {(u) => {
          const chart = [...u.data.records]
            .reverse()
            .map((r) => ({ date: r.date.slice(5), cost: r.estimatedCostUsd, requests: r.aiRequestCount }));
          return (
            <div className="grid two">
              <div className="card">
                <h3>Estimated daily AI cost (USD)</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chart}>
                    <CartesianGrid stroke="#2a3346" strokeDasharray="3 3" />
                    <XAxis dataKey="date" stroke="#93a0b8" fontSize={11} />
                    <YAxis stroke="#93a0b8" fontSize={11} />
                    <Tooltip contentStyle={{ background: '#171d2b', border: '1px solid #2a3346' }} />
                    <Bar dataKey="cost" fill="#4f8cff" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="card">
                <h3>Usage totals & model breakdown</h3>
                <div className="detail-grid">
                  <div className="k">AI requests</div><div>{u.data.totals.requests.toLocaleString()}</div>
                  <div className="k">Input tokens</div><div>{u.data.totals.inputTokens.toLocaleString()}</div>
                  <div className="k">Output tokens</div><div>{u.data.totals.outputTokens.toLocaleString()}</div>
                  <div className="k">Est. total cost</div><div>${u.data.totals.costUsd.toFixed(2)}</div>
                </div>
                <h3 style={{ marginTop: 20 }}>Daily records</h3>
                <table>
                  <thead>
                    <tr><th>Date</th><th>Model</th><th>Requests</th><th>Cost</th></tr>
                  </thead>
                  <tbody>
                    {u.data.records.map((r) => (
                      <tr key={r.id} style={{ cursor: 'default' }}>
                        <td>{fmtTime(r.date)}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{r.modelId}</td>
                        <td>{r.aiRequestCount}</td>
                        <td>${r.estimatedCostUsd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        }}
      </AsyncView>
    </div>
  );
}
