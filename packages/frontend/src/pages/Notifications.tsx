import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import {
  notificationsApi, servicesApi,
  type NotifChannel, type NotifChannelStatus, type NotifRule, type NotifRuleInput, type NotifSeverity,
} from '../api/endpoints';
import {
  PageHeader, Card, Button, Input, Select, FilterBar, AsyncView, StatusBadge, SeverityBadge, fmtTime,
} from '../components/ui';

const CHANNELS: NotifChannel[] = ['EMAIL', 'SLACK', 'TEAMS'];
const SEVERITIES: NotifSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const STATUSES = ['SENT', 'FAILED', 'DRY_RUN', 'SKIPPED_DEDUP', 'SKIPPED_RATE_LIMIT', 'SKIPPED_NOT_CONFIGURED'];
const CHANNEL_LABEL: Record<NotifChannel, string> = { EMAIL: 'Email (Amazon SNS)', SLACK: 'Slack', TEAMS: 'Microsoft Teams' };
const CHANNEL_ENV: Record<NotifChannel, string> = { EMAIL: 'ALERT_SNS_TOPIC_ARN', SLACK: 'SLACK_WEBHOOK_URL', TEAMS: 'TEAMS_WEBHOOK_URL' };
const EMPTY_RULE: NotifRuleInput = { name: '', enabled: true, minSeverity: 'HIGH', services: [], anomalyTypes: [], channels: ['EMAIL', 'SLACK', 'TEAMS'] };

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Request failed');

/** Notifications (DPI 2 item 6). Reading needs alerts:view; changing rules/settings and test-send need alerts:rules. */
export function Notifications() {
  const { can } = useAuth();
  const canEdit = can('alerts:rules');
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const channels = useApi(() => notificationsApi.channels(), []);
  const rules = useApi(() => notificationsApi.rules(), []);
  const settings = useApi(() => notificationsApi.settings(), []);
  const services = useApi(() => servicesApi.list(), []);

  const run = async (fn: () => Promise<unknown>, after: () => void) => {
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      setError(errText(e));
    }
  };

  const onTest = (channel: NotifChannel) =>
    run(async () => {
      const r = await notificationsApi.test(channel, 'CRITICAL');
      const outcome =
        r.status === 'SENT' ? 'sent'
          : r.status === 'DRY_RUN' ? 'dry-run (nothing was sent)'
            : r.status === 'SKIPPED_NOT_CONFIGURED' ? 'not delivered: channel not configured'
              : `failed${r.error ? ` (${r.error})` : ''}`;
      setTestResult(`Test message for ${CHANNEL_LABEL[channel]}: ${outcome}.`);
    }, () => logState.reload());

  // ---- delivery log ----
  const [filters, setFilters] = useState({ channel: '', status: '', alertId: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const logState = useApi(() => notificationsApi.log({ ...applied, page, pageSize: 25 }), [applied, page]);

  return (
    <div className="stack">
      <PageHeader
        title="Notifications"
        subtitle="Automatic alert notifications by e-mail (Amazon SNS), Slack and Microsoft Teams. Default rules are a DRAFT pending Urbani's input."
        source="LIVE"
      />
      {error && <div className="form-error" role="alert">{error}</div>}
      {testResult && <div role="status" className="text-secondary">{testResult}</div>}

      <Card title="Channels">
        <AsyncView state={channels}>
          {(list) => (
            <>
              {list.every((c) => c.status === 'NOT_CONFIGURED') && (
                <p className="text-secondary">
                  No channels configured yet. Set SLACK_WEBHOOK_URL / TEAMS_WEBHOOK_URL / ALERT_SNS_TOPIC_ARN on the backend. Until then
                  matching alerts are recorded as &quot;not delivered: channel not configured&quot;.
                </p>
              )}
              <div className="channel-grid">
                {list.map((c) => <ChannelCard key={c.channel} c={c} canEdit={canEdit} onTest={() => void onTest(c.channel)} />)}
              </div>
            </>
          )}
        </AsyncView>
      </Card>

      <RulesCard rules={rules} canEdit={canEdit} serviceNames={(services.data?.data ?? []).map((s) => s.id)} setError={setError} />

      <Card title="Dedup and rate limit">
        <AsyncView state={settings}>
          {(s) => <SettingsForm initial={s} canEdit={canEdit} onSaved={settings.reload} setError={setError} />}
        </AsyncView>
      </Card>

      <Card title="Delivery log" actions={<Button size="sm" variant="ghost" onClick={logState.reload}>Refresh</Button>}>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setPage(1);
            setApplied(filters);
          }}
        >
          <FilterBar>
            <Select aria-label="Filter by channel" value={filters.channel} onChange={(e) => setFilters({ ...filters, channel: e.target.value })}>
              <option value="">All channels</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
            <Select aria-label="Filter by status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            <Input type="search" placeholder="Alert id" aria-label="Filter by alert id" value={filters.alertId} onChange={(e) => setFilters({ ...filters, alertId: e.target.value })} />
            <Button type="submit" size="sm">Apply</Button>
          </FilterBar>
        </form>
        <AsyncView state={logState}>
          {(l) =>
            l.items.length === 0 ? (
              <p className="text-secondary" style={{ padding: 'var(--space-4)' }}>
                No notifications recorded yet. They appear here when an alert matches an enabled rule, or after a test send.
              </p>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Time</th><th>Channel</th><th>Status</th><th>Alert</th><th>Message</th><th>Attempts</th><th>Detail</th></tr>
                    </thead>
                    <tbody>
                      {l.items.map((e) => (
                        <tr key={e.id}>
                          <td>{fmtTime(e.timestamp)}</td>
                          <td>{e.channel}</td>
                          <td><StatusBadge status={e.status} /></td>
                          <td className="cell-mono">{e.isTest ? 'TEST' : e.alertId ?? '—'}</td>
                          <td>{e.summary ?? '—'}</td>
                          <td>{e.attempts}</td>
                          <td>{e.error ?? e.providerMessageId ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="filter-bar">
                  <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <span className="text-secondary">Page {page} of {Math.max(1, Math.ceil(l.total / l.pageSize))} ({l.total} entries)</span>
                  <Button size="sm" variant="secondary" disabled={page * l.pageSize >= l.total} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              </>
            )
          }
        </AsyncView>
      </Card>
    </div>
  );
}

function ChannelCard({ c, canEdit, onTest }: { c: NotifChannelStatus; canEdit: boolean; onTest: () => void }) {
  return (
    <Card title={CHANNEL_LABEL[c.channel]} actions={<StatusBadge status={c.status} />}>
      <div className="channel-card-body">
        <div className="text-secondary">
          {c.status === 'CONFIGURED' && <>Destination: <span className="cell-mono">{c.destination}</span></>}
          {c.status === 'DRY_RUN' && 'Dry-run mode: messages are logged, not sent (NOTIFICATIONS_DRY_RUN).'}
          {c.status === 'NOT_CONFIGURED' && <>Not configured: {c.reason ?? `set ${CHANNEL_ENV[c.channel]}`}.</>}
        </div>
        {canEdit && (
          <div>
            <Button size="sm" variant="secondary" onClick={onTest}>Send test</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function SettingsForm(props: {
  initial: { dedupWindowMinutes: number; maxPerHourPerChannel: number };
  canEdit: boolean;
  onSaved: () => void;
  setError: (m: string | null) => void;
}) {
  const [dedup, setDedup] = useState(String(props.initial.dedupWindowMinutes));
  const [cap, setCap] = useState(String(props.initial.maxPerHourPerChannel));
  const [saved, setSaved] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    props.setError(null);
    try {
      await notificationsApi.updateSettings({ dedupWindowMinutes: Number(dedup), maxPerHourPerChannel: Number(cap) });
      setSaved(true);
      props.onSaved();
    } catch (err) {
      props.setError(errText(err));
    }
  };
  return (
    <form className="user-form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span className="field-label">Dedup window (minutes)</span>
        <Input type="number" min={0} max={10080} required disabled={!props.canEdit} value={dedup} onChange={(e) => { setSaved(false); setDedup(e.target.value); }} />
      </label>
      <label className="field">
        <span className="field-label">Max notifications per hour per channel</span>
        <Input type="number" min={1} max={1000} required disabled={!props.canEdit} value={cap} onChange={(e) => { setSaved(false); setCap(e.target.value); }} />
      </label>
      {props.canEdit && <Button type="submit">Save</Button>}
      {saved && <span role="status" className="text-secondary">Saved.</span>}
      <p className="text-secondary" style={{ gridColumn: '1 / -1', margin: 0 }}>
        The same service and anomaly type is notified at most once per window and channel; an alert notifies each channel once.
      </p>
    </form>
  );
}

function RulesCard(props: {
  rules: ReturnType<typeof useApi<NotifRule[]>>;
  canEdit: boolean;
  serviceNames: string[];
  setError: (m: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState<NotifRule | null>(null);
  const [form, setForm] = useState<NotifRuleInput>(EMPTY_RULE);
  const [anomalies, setAnomalies] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const begin = (rule: NotifRule | null) => {
    setEditing(rule);
    setForm(rule ? { name: rule.name, enabled: rule.enabled, minSeverity: rule.minSeverity, services: rule.services, anomalyTypes: rule.anomalyTypes, channels: rule.channels } : EMPTY_RULE);
    setAnomalies(rule ? rule.anomalyTypes.join(', ') : '');
    setOpen(true);
  };
  const toggleChannel = (c: NotifChannel) =>
    setForm({ ...form, channels: form.channels.includes(c) ? form.channels.filter((x) => x !== c) : [...form.channels, c] });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    props.setError(null);
    if (form.channels.length === 0) return props.setError('Pick at least one channel.');
    const body = { ...form, anomalyTypes: anomalies.split(',').map((s) => s.trim()).filter(Boolean) };
    try {
      if (editing) await notificationsApi.updateRule(editing.id, body);
      else await notificationsApi.createRule(body);
      setOpen(false);
      props.rules.reload();
    } catch (err) {
      props.setError(errText(err));
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    props.setError(null);
    try {
      await fn();
      props.rules.reload();
    } catch (err) {
      props.setError(errText(err));
    }
  };

  return (
    <Card title="Rules" actions={props.canEdit ? <Button size="sm" onClick={() => begin(null)}>New rule</Button> : undefined}>
      <AsyncView state={props.rules}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-secondary">No rules. Without an enabled rule no notification is sent.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Name</th><th>Min severity</th><th>Services</th><th>Anomaly types</th><th>Channels</th><th>Enabled</th>{props.canEdit && <th>Actions</th>}</tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td><SeverityBadge severity={r.minSeverity} /></td>
                      <td>{r.services.length ? r.services.join(', ') : 'All'}</td>
                      <td>{r.anomalyTypes.length ? r.anomalyTypes.join(', ') : 'All'}</td>
                      <td>{r.channels.join(', ')}</td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Enable rule ${r.name}`}
                          checked={r.enabled}
                          disabled={!props.canEdit}
                          onChange={(e) => void act(() => notificationsApi.updateRule(r.id, { enabled: e.target.checked }))}
                        />
                      </td>
                      {props.canEdit && (
                        <td>
                          <Button size="sm" variant="secondary" onClick={() => begin(r)}>Edit</Button>{' '}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => { if (window.confirm(`Delete rule "${r.name}"?`)) void act(() => notificationsApi.deleteRule(r.id)); }}
                          >
                            Delete
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </AsyncView>
      <dialog ref={dialog} className="notif-dialog" onClose={() => setOpen(false)} aria-labelledby="rule-dialog-title">
        <form onSubmit={(e) => void save(e)}>
          <h2 id="rule-dialog-title" style={{ margin: 0 }}>{editing ? 'Edit rule' : 'New rule'}</h2>
          <label className="field">
            <span className="field-label">Name</span>
            <Input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Minimum severity</span>
            <Select value={form.minSeverity} onChange={(e) => setForm({ ...form, minSeverity: e.target.value as NotifSeverity })}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </label>
          <label className="field">
            <span className="field-label">Services (none selected = all)</span>
            <select
              className="select"
              multiple
              size={Math.min(6, Math.max(3, props.serviceNames.length))}
              value={form.services}
              onChange={(e) => setForm({ ...form, services: Array.from(e.target.selectedOptions, (o) => o.value) })}
            >
              {[...new Set([...props.serviceNames, ...form.services])].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Anomaly types (comma separated, empty = all)</span>
            <Input value={anomalies} onChange={(e) => setAnomalies(e.target.value)} />
          </label>
          <fieldset className="field">
            <legend className="field-label">Channels</legend>
            <div className="check-row">
              {CHANNELS.map((c) => (
                <label key={c}>
                  <input type="checkbox" checked={form.channels.includes(c)} onChange={() => toggleChannel(c)} /> {c}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="check-row">
            <span><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</span>
          </label>
          <div className="check-row">
            <Button type="submit">Save</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      </dialog>
    </Card>
  );
}
