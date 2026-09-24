import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { aiApi, servicesApi } from '../api/endpoints';
import {
  PageHeader, Card, Button, Select, AsyncView, Confidence, fmtTime, SourceBadge,
} from '../components/ui';

/** AI Insights (Part 22). Provider-agnostic — the UI cannot tell Mock from
 *  Bedrock; it only reads the AIProvider contract. MOCK-labelled in Phase 1. */
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
    <div className="stack">
      <PageHeader
        title="AI Insights"
        subtitle="Provider-agnostic analyses. Phase 1 uses MockAIProvider; Bedrock activates in a later phase with no UI change."
        source="MOCK"
      />

      <Card title="Run advisory analysis" titleSub="Human-in-the-loop — produces a finding only">
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <Select value={service} onChange={(e) => setService(e.target.value)} aria-label="Service">
            {services.data?.data.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </Select>
          <Select value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label="Environment">
            <option>production-eb</option>
            <option>staging-eb</option>
          </Select>
          <Button onClick={runAnalysis} disabled={busy}>{busy ? 'Analyzing…' : 'Analyze telemetry'}</Button>
        </div>
        <p className="text-secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          Deterministic (temperature 0.0), evidence-based, guardrailed. Never triggers an automated action.
        </p>
      </Card>

      <Card title="Recent AI analyses">
        <AsyncView state={analyses}>
          {(an) => an.data.items.length === 0 ? (
            <p className="text-secondary">No analyses yet.</p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Time</th><th>Provider</th><th>Service</th><th>Anomaly</th><th>Confidence</th><th>Model</th><th>Tokens (in/out)</th><th>Source</th></tr>
                  </thead>
                  <tbody>
                    {an.data.items.map((a) => (
                      <tr key={a.id}>
                        <td>{fmtTime(a.timestamp)}</td>
                        <td>{a.provider}</td>
                        <td>{a.service}</td>
                        <td>{a.anomalyType ?? <span className="text-muted">NO_ANOMALY</span>}</td>
                        <td><Confidence value={a.confidence} /></td>
                        <td className="cell-mono">{a.modelId}</td>
                        <td>{a.inputTokens}/{a.outputTokens}</td>
                        <td><SourceBadge source={(a.dataSource as 'MOCK' | 'LIVE' | 'WAITING_FOR_INTEGRATION') ?? 'MOCK'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pagination">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
                <span className="page-info">Page {page}</span>
                <Button variant="secondary" size="sm" disabled={page * 25 >= an.data.total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
