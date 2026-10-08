import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { aiApi, alertsApi, servicesApi } from '../api/endpoints';
import {
  PageHeader, Card, Button, Select, AsyncView, Confidence, fmtTime, SourceBadge, SeverityBadge,
} from '../components/ui';

/** AI Insights (Part 22). The LIVE section surfaces the real Bedrock Nova 2 Lite
 *  incident analyses per enabled service; the batch Analyze tool stays MOCK (no
 *  QA analyze endpoint). The UI cannot tell Mock from Bedrock — it only reads the
 *  AIProvider / alerts contract. */
export function AIInsights() {
  const [page, setPage] = useState(1);
  const [service, setService] = useState('main');
  const [environment, setEnvironment] = useState('qa');
  const [busy, setBusy] = useState(false);

  const services = useApi(() => servicesApi.list(), []);
  const analyses = useApi(() => aiApi.list({ page }), [page]);

  const enabledServices = (services.data?.data ?? []).filter((s) => s.enabled !== false);

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
        subtitle="Live incident analyses come from the real alerts pipeline (Amazon Bedrock Nova 2 Lite). The batch analyze tool below is seeded/MOCK until an AWS analyze endpoint is provided."
        source="MOCK"
      />

      <Card title="Live incident analysis — Amazon Bedrock Nova 2 Lite" titleSub="Newest live alert per enabled service">
        <AsyncView state={services}>
          {() => (
            <div className="grid two">
              {enabledServices.map((svc) => (
                <LiveServiceAnalysis key={svc.id} service={svc.name} />
              ))}
            </div>
          )}
        </AsyncView>
      </Card>

      <Card title="Run advisory analysis" titleSub="MOCK — human-in-the-loop, produces a finding only">
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <Select value={service} onChange={(e) => setService(e.target.value)} aria-label="Service">
            {enabledServices.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </Select>
          <Select value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label="Environment">
            <option>qa</option>
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

/** The newest live alert analysis for one enabled service (LIVE-badged). */
function LiveServiceAnalysis({ service }: { service: string }) {
  const latest = useApi(() => alertsApi.list({ service, pageSize: 1 }), [service]);
  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {service}
        <SourceBadge source={(latest.data?.source as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION') ?? 'MOCK'} />
      </div>
      <AsyncView state={latest}>
        {(res) => {
          const alert = res.data.items[0];
          if (!alert) return <p className="text-secondary">No current incident for {service}.</p>;
          return (
            <div className="detail-grid">
              <div className="k">Severity</div><div><SeverityBadge severity={alert.severity} /></div>
              <div className="k">Anomaly</div><div>{alert.anomalyType}</div>
              <div className="k">Summary</div><div>{alert.summary}</div>
              <div className="k">Probable cause</div><div>{alert.probableCause}</div>
              <div className="k">Recommendation</div>
              <div>
                {alert.recommendedActions.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {alert.recommendedActions.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                ) : '—'}
              </div>
              <div className="k">Confidence</div><div><Confidence value={alert.confidence} /></div>
              <div className="k">Model</div><div className="cell-mono">{alert.modelId}</div>
            </div>
          );
        }}
      </AsyncView>
    </div>
  );
}
