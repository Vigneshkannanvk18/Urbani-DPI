import { useParams, Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { alertsApi } from '../api/endpoints';
import {
  PageHeader, Card, Button, SeverityBadge, StatusBadge, Confidence, fmtTime, AsyncView,
} from '../components/ui';
import { IconChevronLeft, IconWarn } from '../components/icons';

/** Alert detail (Part 19): a professional incident investigation view.
 *  Human-in-the-loop — the only action is acknowledge; no automated remediation. */
export function AlertDetail() {
  const { id = '' } = useParams();
  const alert = useApi(() => alertsApi.get(id), [id]);

  const acknowledge = async () => {
    await alertsApi.acknowledge(id);
    alert.reload();
  };

  return (
    <div className="stack">
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <Link to="/alerts" className="row" style={{ gap: 4, fontSize: 13 }}>
          <IconChevronLeft size={16} /> Back to alerts
        </Link>
      </div>

      <AsyncView state={alert}>
        {(res) => {
          const a = res.data;
          return (
            <>
              <PageHeader
                title={a.anomalyType}
                subtitle={<span className="cell-mono">{a.alertId}</span>}
                source="MOCK"
                actions={
                  a.status === 'OPEN' ? (
                    <Button onClick={acknowledge}>Acknowledge (human review)</Button>
                  ) : (
                    <StatusBadge status={a.status} />
                  )
                }
              />

              {/* Severity / Status / Confidence summary strip */}
              <div className="grid three">
                <Card><div className="metric-label">Severity</div><div className="mt-2"><SeverityBadge severity={a.severity} /></div></Card>
                <Card><div className="metric-label">Status</div><div className="mt-2"><StatusBadge status={a.status} /></div></Card>
                <Card><div className="metric-label">AI Confidence</div><div className="metric-value mt-2"><Confidence value={a.confidence} /></div></Card>
              </div>

              <div className="grid two">
                <Card title="Summary">
                  <p style={{ marginTop: 0 }}>{a.summary}</p>
                  <div className="detail-grid mt-4">
                    <div className="k">Detection time</div><div>{fmtTime(a.timestamp)}</div>
                    <div className="k">Service</div><div>{a.service}</div>
                    <div className="k">Environment</div><div>{a.environment}</div>
                    <div className="k">Model</div><div className="cell-mono">{a.modelId}</div>
                    {a.acknowledgedBy && (<><div className="k">Acknowledged by</div><div>{a.acknowledgedBy} · {fmtTime(a.acknowledgedAt)}</div></>)}
                  </div>
                </Card>

                <Card title="Probable Cause">
                  <p style={{ marginTop: 0 }}>{a.probableCause}</p>
                  <h3 className="section-title mt-4" style={{ fontSize: 'var(--text-card)' }}>Recommended Actions</h3>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    {a.recommendedActions.map((r, i) => (<li key={i} style={{ marginBottom: 6 }}>{r}</li>))}
                  </ol>
                  <div className="banner mt-4" style={{ marginBottom: 0 }}>
                    <span className="banner-icon"><IconWarn size={16} /></span>
                    <span>Advisory only. An engineer must review before any operational action.</span>
                  </div>
                </Card>
              </div>

              <Card title="Evidence" titleSub="Cited log lines">
                {a.evidence.map((line, i) => <div className="evidence-line" key={i}>{line}</div>)}
              </Card>

              <div className="grid two">
                <Card title="Related Logs">
                  {a.relatedLogs.length === 0 ? <p className="text-secondary">No related logs linked.</p> : (
                    <div className="table-wrap">
                      <table className="data">
                        <thead><tr><th>Time</th><th>Level</th><th>Message</th></tr></thead>
                        <tbody>
                          {a.relatedLogs.map((l) => (
                            <tr key={l.id}>
                              <td>{fmtTime(l.timestamp)}</td>
                              <td>{l.level}</td>
                              <td className="cell-mono">{l.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
                <Card title="Related Metrics">
                  <p className="text-secondary" style={{ marginTop: 0 }}>
                    {a.relatedMetricIds.length} metric snapshot(s) linked to this alert. Full metric
                    correlation expands with live CloudWatch data in a later phase.
                  </p>
                </Card>
              </div>
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}
