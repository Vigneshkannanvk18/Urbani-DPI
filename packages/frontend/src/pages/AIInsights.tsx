import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { aiApi, servicesApi } from '../api/endpoints';
import { AsyncView } from '../components/states';
import { PageHeader, Confidence, fmtTime } from '../components/ui';

/**
 * AI Insights (Epic 8). Renders the future AI response structure. The UI cannot
 * tell whether a finding came from MockAIProvider or BedrockAIProvider — it only
 * knows the AIProvider contract (alertId, summary, evidence, recommendedActions,
 * confidence, modelId, …).
 */
export function AIInsights() {
  const [page, setPage] = useState(1);
  const [service, setService] = useState('urbani-core-api');
  const [environment, setEnvironment] = useState('production-eb');
  const [busy, setBusy] = useState(false);

  const services = useApi(() => servicesApi.list(), []);
  const analyses = useApi(() => aiApi.list({ page }), [page]);

  const runAnalysis = async () => {
    setBusy(true);
    try {
      await aiApi.analyze(service, environment);
      analyses.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="AI Insights"
        subtitle="Provider-agnostic AI analyses. Phase 1 uses MockAIProvider; Bedrock activates in Phase 3."
        source="MOCK"
      />

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Run advisory analysis (human-in-the-loop)</h3>
        <div className="filters" style={{ marginBottom: 0 }}>
          <select value={service} onChange={(e) => setService(e.target.value)}>
            {services.data?.data.map((s) => (
              <option key={s.id} value={s.name}>{s.name}</option>
            ))}
          </select>
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option>production-eb</option>
            <option>staging-eb</option>
          </select>
          <button className="btn" disabled={busy} onClick={runAnalysis}>
            {busy ? 'Analyzing…' : 'Analyze telemetry'}
          </button>
        </div>
        <p className="page-sub" style={{ fontSize: 12, marginTop: 10 }}>
          Deterministic (temperature 0.0), evidence-based, guardrailed. Produces a finding only — never
          an automated action.
        </p>
      </div>

      <div className="card">
        <h3>Recent AI analyses</h3>
        <AsyncView state={analyses}>
          {(an) =>
            an.data.items.length === 0 ? (
              <div className="state">No analyses yet.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Time</th><th>Provider</th><th>Service</th><th>Anomaly</th>
                    <th>Confidence</th><th>Model</th><th>Tokens (in/out)</th>
                  </tr>
                </thead>
                <tbody>
                  {an.data.items.map((a) => (
                    <tr key={a.id} style={{ cursor: 'default' }}>
                      <td>{fmtTime(a.timestamp)}</td>
                      <td>{a.provider}</td>
                      <td>{a.service}</td>
                      <td>{a.anomalyType ?? <span style={{ color: 'var(--text-dim)' }}>NO_ANOMALY</span>}</td>
                      <td><Confidence value={a.confidence} /></td>
                      <td className="mono" style={{ fontSize: 11 }}>{a.modelId}</td>
                      <td>{a.inputTokens}/{a.outputTokens}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </AsyncView>
        {analyses.data && (
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <button
              className="btn secondary"
              disabled={page * 25 >= analyses.data.data.total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
