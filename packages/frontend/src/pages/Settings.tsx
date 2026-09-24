import { useApi } from '../hooks/useApi';
import { settingsApi } from '../api/endpoints';
import { AsyncView, SourceBadge } from '../components/states';
import { PageHeader } from '../components/ui';

/**
 * Settings (Epic 12). Read-only, placeholder configuration in Phase 1. Secrets
 * are NEVER shown — only presence flags and public config values.
 */
export function Settings() {
  const settings = useApi(() => settingsApi.get(), []);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Environment-driven configuration (read-only in Phase 1). No secrets are exposed."
        source="MOCK"
      />
      <AsyncView state={settings}>
        {(s) => (
          <div className="grid two">
            <Section title="General">
              <Row k="Application" v={s.general.appName} />
              <Row k="Environment" v={s.general.environment} />
              <Row k="Integration mode" v={s.general.integrationMode} />
            </Section>

            <Section title="AWS Integration">
              <Row k="Region" v={s.aws.region} />
              <Row k="Static credentials" v={s.aws.hasStaticCredentials ? 'Present' : 'Not set (use IAM role)'} />
            </Section>

            <Section title="CloudWatch">
              <Row k="Log group" v={s.cloudwatch.logGroup} mono />
              <Row k="Max log lines" v={String(s.cloudwatch.maxLogLines)} />
              <Row k="Query window (min)" v={String(s.cloudwatch.queryWindowMinutes)} />
            </Section>

            <Section title="DynamoDB">
              <Row k="Alerts table" v={s.dynamodb.alertsTable} mono />
              <Row k="GSI" v={s.dynamodb.anomalyTypeGsi} mono />
            </Section>

            <Section title="AI Configuration">
              <Row k="Primary model" v={s.ai.primaryModelId} mono />
              <Row k="Fallback model" v={s.ai.fallbackModelId} mono />
              <Row k="Guardrail" v={s.ai.guardrailId} mono />
              <Row k="Temperature" v={String(s.ai.temperature)} />
              <Row k="Max tokens" v={String(s.ai.maxTokens)} />
              <Row k="Top P" v={String(s.ai.topP)} />
            </Section>

            <Section title="Cost / Budget">
              <Row k="Daily budget" v={`$${s.cost.dailyBudgetUsd}`} />
              <Row k="Monthly budget" v={`$${s.cost.monthlyBudgetUsd}`} />
              <Row k="Soft / hard alert" v={`$${s.cost.softAlertUsd} / $${s.cost.hardAlertUsd}`} />
              <Row k="Collector schedule" v={`every ${s.scheduler.collectorMinutes} min`} />
            </Section>

            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <h3>Integrations</h3>
              <table>
                <thead>
                  <tr><th>Integration</th><th>Kind</th><th>Mode</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {s.integrations.map((i) => (
                    <tr key={i.kind} style={{ cursor: 'default' }}>
                      <td>{i.displayName}</td>
                      <td className="mono">{i.kind}</td>
                      <td>{i.mode}</td>
                      <td>
                        <SourceBadge source={i.status as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </AsyncView>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="detail-grid">{children}</div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <div className="k">{k}</div>
      <div className={mono ? 'mono' : undefined} style={mono ? { fontSize: 12 } : undefined}>{v}</div>
    </>
  );
}
