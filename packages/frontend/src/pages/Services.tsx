import { useApi } from '../hooks/useApi';
import { servicesApi } from '../api/endpoints';
import { AsyncView } from '../components/states';
import { PageHeader, fmtTime } from '../components/ui';

/** Services / Applications (Epic 9). Seeded services; Phase 2 = EB discovery. */
export function Services() {
  const services = useApi(() => servicesApi.list(), []);

  return (
    <div>
      <PageHeader
        title="Services / Applications"
        subtitle="Monitored services. Phase 2 populates these from the Urbani Elastic Beanstalk environment."
        source="MOCK"
      />
      <div className="card">
        <AsyncView state={services}>
          {(s) =>
            s.data.length === 0 ? (
              <div className="state">No services discovered.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Service</th><th>Environment</th><th>Status</th>
                    <th>Error rate</th><th>Alerts</th><th>Last telemetry</th><th>Last incident</th>
                  </tr>
                </thead>
                <tbody>
                  {s.data.map((svc) => (
                    <tr key={svc.id} style={{ cursor: 'default' }}>
                      <td>{svc.name}</td>
                      <td>{svc.environment}</td>
                      <td className={`status-${svc.status}`} style={{ fontWeight: 600 }}>{svc.status}</td>
                      <td>{svc.errorRate.toFixed(1)}%</td>
                      <td>{svc.alertCount}</td>
                      <td>{fmtTime(svc.lastTelemetryAt)}</td>
                      <td>{fmtTime(svc.lastIncidentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </AsyncView>
      </div>
    </div>
  );
}
