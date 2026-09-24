import { useParams, Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { alertsApi } from '../api/endpoints';
import { AsyncView } from '../components/states';
import { PageHeader, SeverityBadge, Confidence, fmtTime } from '../components/ui';

/**
 * Alert detail (Epic 5). Shows the full evidence-based finding so an engineer
 * can answer: what happened, what evidence supports it, what to investigate.
 * Acknowledgement is the only action — no automated remediation.
 */
export function AlertDetail() {
  const { id = '' } = useParams();
  const alert = useApi(() => alertsApi.get(id), [id]);

  const acknowledge = async () => {
    await alertsApi.acknowledge(id);
    alert.reload();
  };

  return (
    <div>
      <PageHeader title="Alert Detail" source="MOCK" />
      <p style={{ marginTop: -12, marginBottom: 16 }}>
        <Link to="/alerts">← Back to alerts</Link>
      </p>

      <AsyncView state={alert}>
        {(res) => {
          const a = res.data;
          return (
            <div className="grid two">
              <div className="card">
                <h3>1. Summary</h3>
                <p>{a.summary}</p>

                <div className="detail-grid" style={{ marginTop: 16 }}>
                  <div className="k">2. Severity</div>
                  <div><SeverityBadge severity={a.severity} /></div>
                  <div className="k">3. Detection time</div>
                  <div>{fmtTime(a.timestamp)}</div>
                  <div className="k">4. Service</div>
                  <div>{a.service} · {a.environment}</div>
                  <div className="k">Anomaly type</div>
                  <div>{a.anomalyType}</div>
                  <div className="k">Status</div>
                  <div>
                    {a.status}
                    {a.acknowledgedBy ? ` · by ${a.acknowledgedBy} at ${fmtTime(a.acknowledgedAt)}` : ''}
                  </div>
                  <div className="k">8. AI confidence</div>
                  <div><Confidence value={a.confidence} /></div>
                  <div className="k">9. Model</div>
                  <div className="mono" style={{ fontSize: 12 }}>{a.modelId}</div>
                </div>

                {a.status === 'OPEN' && (
                  <button className="btn" style={{ marginTop: 16 }} onClick={acknowledge}>
                    Acknowledge (human review)
                  </button>
                )}
              </div>

              <div className="card">
                <h3>6. Probable cause</h3>
                <p>{a.probableCause}</p>

                <h3 style={{ marginTop: 20 }}>7. Recommended troubleshooting actions</h3>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {a.recommendedActions.map((r, i) => (
                    <li key={i} style={{ marginBottom: 6 }}>{r}</li>
                  ))}
                </ol>
                <p className="page-sub" style={{ fontSize: 12, marginTop: 10 }}>
                  Advisory only. An engineer must review before any operational action.
                </p>
              </div>

              <div className="card" style={{ gridColumn: '1 / -1' }}>
                <h3>5. Evidence (cited log lines)</h3>
                {a.evidence.map((line, i) => (
                  <div className="evidence-line" key={i}>{line}</div>
                ))}

                <h3 style={{ marginTop: 20 }}>10. Related logs</h3>
                {a.relatedLogs.length === 0 ? (
                  <div className="state">No related logs linked.</div>
                ) : (
                  <table>
                    <thead>
                      <tr><th>Time</th><th>Level</th><th>Message</th></tr>
                    </thead>
                    <tbody>
                      {a.relatedLogs.map((l) => (
                        <tr key={l.id}>
                          <td>{fmtTime(l.timestamp)}</td>
                          <td>{l.level}</td>
                          <td className="mono">{l.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <h3 style={{ marginTop: 20 }}>11. Related metrics</h3>
                <p className="page-sub" style={{ fontSize: 13 }}>
                  {a.relatedMetricIds.length} metric snapshot(s) linked. Metric correlation UI expands
                  in Phase 2 with live CloudWatch data.
                </p>
              </div>
            </div>
          );
        }}
      </AsyncView>
    </div>
  );
}
