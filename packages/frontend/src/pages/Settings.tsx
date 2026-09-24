import { useApi } from '../hooks/useApi';
import { settingsApi } from '../api/endpoints';
import { PageHeader, Card, AsyncView, SourceBadge } from '../components/ui';
import type { ReactNode } from 'react';

/** Settings (Part 26). Read-only, environment-driven configuration in Phase 1.
 *  Secrets are NEVER shown — only presence flags and public config values. */
export function Settings() {
  const settings = useApi(() => settingsApi.get(), []);

  return (
    <div className="stack">
      <PageHeader
        title="Settings"
        subtitle="Environment-driven configuration (read-only in Phase 1). No secrets are exposed."
        source="MOCK"
      />
      <AsyncView state={settings}>
        {(s) => (
          <div className="grid two">
            <Card title="General">
              <div className="detail-grid">
                <Row k="Application" v={s.general.appName} />
                <Row k="Environment" v={s.general.environment} />
                <Row k="Integration mode" v={s.general.integrationMode} />
              </div>
            </Card>

            <Card title="AWS Integration">
              <div className="detail-grid">
                <Row k="Region" v={s.aws.region} />
                <Row k="Account ID" v={s.aws.accountId ?? 'Not set'} mono />
                <Row k="Static credentials" v={s.aws.hasStaticCredentials ? 'Present' : 'Not set (use IAM role)'} />
              </div>
            </Card>

            <Card title="CloudWatch">
              <div className="detail-grid">
                <Row k="Log group" v={s.cloudwatch.logGroup} mono />
                <Row k="Max log lines" v={String(s.cloudwatch.maxLogLines)} />
                <Row k="Query window (min)" v={String(s.cloudwatch.queryWindowMinutes)} />
              </div>
            </Card>

            <Card title="DynamoDB">
              <div className="detail-grid">
                <Row k="Alerts table" v={s.dynamodb.alertsTable} mono />
                <Row k="GSI" v={s.dynamodb.anomalyTypeGsi} mono />
              </div>
            </Card>

            <Card title="AI Configuration">
              <div className="detail-grid">
                <Row k="Primary model" v={s.ai.primaryModelId} mono />
                <Row k="Fallback model" v={s.ai.fallbackModelId} mono />
                <Row k="Guardrail" v={s.ai.guardrailId} mono />
                <Row k="Temperature" v={String(s.ai.temperature)} />
                <Row k="Max tokens" v={String(s.ai.maxTokens)} />
                <Row k="Top P" v={String(s.ai.topP)} />
              </div>
            </Card>

            <Card title="Alerts & Budget">
              <div className="detail-grid">
                <Row k="Daily budget" v={`$${s.cost.dailyBudgetUsd}`} />
                <Row k="Monthly budget" v={`$${s.cost.monthlyBudgetUsd}`} />
                <Row k="Soft / hard alert" v={`$${s.cost.softAlertUsd} / $${s.cost.hardAlertUsd}`} />
                <Row k="Collector schedule" v={`every ${s.scheduler.collectorMinutes} min`} />
              </div>
            </Card>

            <Card title="Security" className="">
              <div className="detail-grid">
                <Row k="Secret storage" v="Never exposed via API or UI" />
                <Row k="Auth" v="JWT (bearer) · bcrypt password hashing" />
                <Row k="Login protection" v="Rate limited per IP" />
              </div>
            </Card>

            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <div className="card-title">Integrations</div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Integration</th><th>Kind</th><th>Mode</th><th>Status</th></tr></thead>
                  <tbody>
                    {s.integrations.map((i) => (
                      <tr key={i.kind}>
                        <td>{i.displayName}</td>
                        <td className="cell-mono">{i.kind}</td>
                        <td>{i.mode}</td>
                        <td><SourceBadge source={i.status as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </AsyncView>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <>
      <div className="k">{k}</div>
      <div className={mono ? 'cell-mono' : undefined}>{v}</div>
    </>
  );
}
