import { useApi } from '../hooks/useApi';
import { servicesApi } from '../api/endpoints';
import { PageHeader, Card, StatusBadge, AsyncView, fmtTime } from '../components/ui';

/** Services / Applications (Part 23). Seeded services; Phase 2 = EB discovery. */
export function Services() {
  const services = useApi(() => servicesApi.list(), []);

  return (
    <div className="stack">
      <PageHeader
        title="Services / Applications"
        subtitle="Monitored services. Seeded until the AWS services endpoint is provided."
        source={(services.data?.source ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'}
      />
      <Card>
        <AsyncView state={services}>
          {(s) => s.data.length === 0 ? (
            <p className="text-secondary" style={{ padding: 'var(--space-4)' }}>No services discovered.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Service</th><th>Environment</th><th>Status</th>
                    <th>Error rate</th><th>Alerts</th><th>Last activity</th><th>Last incident</th>
                  </tr>
                </thead>
                <tbody>
                  {s.data.map((svc) => (
                    <tr key={svc.id}>
                      <td style={{ fontWeight: 600 }}>{svc.name}</td>
                      <td>{svc.environment}</td>
                      <td><StatusBadge status={svc.status} /></td>
                      <td>{svc.errorRate.toFixed(1)}%</td>
                      <td>{svc.alertCount}</td>
                      <td>{fmtTime(svc.lastTelemetryAt)}</td>
                      <td>{fmtTime(svc.lastIncidentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
