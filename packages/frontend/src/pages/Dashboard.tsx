import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { DASHBOARD_WIDGETS, type DashboardLayout, type WidgetDefinition } from '@urbani/shared/dashboardLayout';
import { useApi } from '../hooks/useApi';
import { dashboardApi, alertsApi, aiApi, usageApi } from '../api/endpoints';
import {
  PageHeader, Card, MetricCard, AsyncView, SeverityBadge, StatusBadge, Confidence, fmtTime, Button,
} from '../components/ui';
import {
  IconServices, IconAlert, IconWarn, IconActivity, IconAI, IconServer,
} from '../components/icons';
import { CHART, chartAxisProps, chartTooltipStyle } from '../components/chart';
import { HealthStrip, useHealthStatus } from '../components/health';
import { useDashboardLayout } from '../hooks/useDashboardLayout';

const WIDGET_BY_ID = new Map<string, WidgetDefinition>(DASHBOARD_WIDGETS.map((w) => [w.id, w]));
const titleOf = (id: string) => WIDGET_BY_ID.get(id)?.title ?? id;

/** Dashboard overview (Parts 14–17) with per-user widget layout (DPI 2 item 12; docs/DASHBOARD_WIDGETS.md). */
export function Dashboard() {
  const summary = useApi(() => dashboardApi.summary(), []);
  const health = useApi(() => dashboardApi.health(), []);
  const alerts = useApi(() => alertsApi.list({ pageSize: 5 }), []);
  const analyses = useApi(() => aiApi.list({ page: 1 }), []);
  const cost = useApi(() => usageApi.cost(), []);
  const s = summary.data?.data;
  const serviceHealth = useHealthStatus();
  const healthState = s?.systemHealth ?? 'UNKNOWN';
  const { layout, save, reset, isCustom } = useDashboardLayout();

  // ---- customize mode state ----
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardLayout>(layout);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [dragReady, setDragReady] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);

  const dirty = editing && JSON.stringify(draft.widgets) !== JSON.stringify(layout.widgets);
  const shown = editing ? draft : layout;

  const startEdit = () => { setDraft(layout); setError(null); setEditing(true); setAnnounce('Customize mode on. Use the move buttons to reorder widgets.'); };
  const cancel = () => { setEditing(false); setError(null); setAnnounce('Changes discarded.'); };
  const onSave = async () => {
    setSaving(true);
    setError(null);
    const ok = await save(draft);
    setSaving(false);
    if (ok) { setEditing(false); setAnnounce('Dashboard layout saved.'); }
    else setError('Could not save your layout. It was not changed; try again.');
  };
  const onReset = async () => {
    setSaving(true);
    setError(null);
    const ok = await reset();
    setSaving(false);
    if (ok) { setEditing(false); setAnnounce('Dashboard layout reset to default.'); }
    else setError('Could not reset your layout. Try again.');
  };
  /** Swap with the nearest VISIBLE neighbour in that direction (hidden widgets are skipped). */
  const move = (id: string, delta: number) => {
    setDraft((d) => {
      const i = d.widgets.findIndex((w) => w.id === id);
      let j = i + delta;
      while (j >= 0 && j < d.widgets.length && !d.widgets[j].visible) j += delta;
      if (i < 0 || j < 0 || j >= d.widgets.length) return d;
      const widgets = d.widgets.slice();
      [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
      const pos = widgets.filter((w) => w.visible).findIndex((w) => w.id === id) + 1;
      setAnnounce(`${titleOf(id)} moved to position ${pos} of ${widgets.filter((w) => w.visible).length}`);
      return { ...d, widgets };
    });
  };
  const moveTo = (id: string, targetId: string) => {
    if (id === targetId) return;
    setDraft((d) => {
      const from = d.widgets.findIndex((w) => w.id === id);
      const to = d.widgets.findIndex((w) => w.id === targetId);
      if (from < 0 || to < 0) return d;
      const widgets = d.widgets.slice();
      const [item] = widgets.splice(from, 1);
      widgets.splice(to, 0, item);
      setAnnounce(`${titleOf(id)} moved to position ${to + 1} of ${widgets.length}`);
      return { ...d, widgets };
    });
  };
  const setVisible = (id: string, visible: boolean) => {
    setDraft((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === id ? { ...w, visible } : w)) }));
    setAnnounce(`${titleOf(id)} ${visible ? 'shown' : 'hidden'}`);
  };

  const widgets: Record<string, () => ReactNode> = {
    kpi: () => (
      <AsyncView state={summary}>
        {(res) => (
          <div className="grid kpi">
            <MetricCard label="Total Services" value={res.data.totalServices} icon={<IconServices size={18} />} />
            <MetricCard label="Active Alerts" value={res.data.activeAlerts} accent icon={<IconAlert size={18} />} foot="Open + acknowledged" />
            <MetricCard label="Critical Alerts" value={res.data.criticalAlerts} icon={<IconWarn size={18} />} foot="Require attention" />
            <MetricCard label="Recent Incidents" value={res.data.recentIncidents} icon={<IconActivity size={18} />} />
            <MetricCard label="AI Analyses" value={res.data.aiAnalyses} icon={<IconAI size={18} />} />
            <MetricCard label="System Health" value={<StatusBadge status={healthState} />} icon={<IconServer size={18} />} />
          </div>
        )}
      </AsyncView>
    ),
    'service-health': () => (
      <Card title="Service health" titleSub="probes, refreshed every 30 s" actions={<Link to="/health">Details</Link>}>
        <AsyncView state={serviceHealth}>{(h) => <HealthStrip targets={h.targets} />}</AsyncView>
      </Card>
    ),
    'system-health': () => (
      <Card title="System Health">
        <AsyncView state={health}>
          {(h) => {
            const monitored = h.data.services.length;
            const degraded = h.data.services.filter((x) => x.status === 'DEGRADED').length;
            const down = h.data.services.filter((x) => x.status === 'DOWN').length;
            return (
              <div>
                <div className="row" style={{ marginBottom: 'var(--space-4)' }}>
                  <StatusBadge status={healthState} />
                  <span className="text-secondary" style={{ fontSize: 13 }}>
                    {healthState === 'HEALTHY' ? 'All systems operating normally' :
                      healthState === 'DEGRADED' ? 'Some services need attention' :
                      healthState === 'DOWN' ? 'Service outage detected' : 'Status unknown'}
                  </span>
                </div>
                <div className="detail-grid">
                  <div className="k">Services monitored</div><div>{monitored}</div>
                  <div className="k">Degraded</div><div>{degraded}</div>
                  <div className="k">Down</div><div>{down}</div>
                  <div className="k">Critical alerts</div><div>{s?.criticalAlerts ?? 0}</div>
                  <div className="k">Active incidents</div><div>{s?.activeAlerts ?? 0}</div>
                </div>
              </div>
            );
          }}
        </AsyncView>
      </Card>
    ),
    'ai-cost': () => (
      <Card title="AI Cost & Budget" titleSub="MOCK — not live billing">
        <AsyncView state={cost}>
          {(c) => {
            const label = c.data.state === 'OK' ? 'Within budget'
              : c.data.state === 'APPROACHING' ? 'Approaching limit' : 'Over budget';
            return (
              <div>
                <div className="row" style={{ marginBottom: 'var(--space-4)' }}>
                  <StatusBadge status={c.data.state} />
                  <span className="text-secondary" style={{ fontSize: 13 }}>{label}</span>
                </div>
                <div className="detail-grid">
                  <div className="k">Daily cost</div><div>${c.data.currentDailyCostUsd.toFixed(2)} / ${c.data.dailyBudgetUsd.toFixed(2)}</div>
                  <div className="k">Monthly cost</div><div>${c.data.currentMonthlyCostUsd.toFixed(2)} / ${c.data.monthlyBudgetUsd.toFixed(2)}</div>
                  <div className="k">Soft alert</div><div>${c.data.softAlertUsd.toFixed(2)}</div>
                  <div className="k">Hard alert</div><div>${c.data.hardAlertUsd.toFixed(2)}</div>
                </div>
              </div>
            );
          }}
        </AsyncView>
      </Card>
    ),
    observability: () => (
      <Card title="Observability" titleSub="Latency p95 (ms) & error rate (%)">
        <AsyncView state={health}>
          {(h) => {
            const data = [...h.data.recentMetrics].slice(0, 20).reverse().map((m) => ({
              t: new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              latency: Math.round(m.latencyMsP95),
              errorRate: Number(m.errorRate.toFixed(2)),
            }));
            return (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="t" {...chartAxisProps} />
                  <YAxis {...chartAxisProps} />
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" name="Latency p95" dataKey="latency" stroke={CHART.primary} strokeWidth={2} dot={false} />
                  <Line type="monotone" name="Error rate" dataKey="errorRate" stroke={CHART.info} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            );
          }}
        </AsyncView>
      </Card>
    ),
    'recent-alerts': () => (
      <Card title="Recent Alerts" actions={<Link to="/alerts">View all</Link>}>
        <AsyncView state={alerts}>
          {(a) => a.data.items.length === 0 ? <p className="text-secondary">No alerts.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Severity</th><th>Service</th><th>Anomaly</th><th>Status</th></tr></thead>
                <tbody>
                  {a.data.items.map((al) => (
                    <tr key={al.alertId} className="clickable">
                      <td><SeverityBadge severity={al.severity} /></td>
                      <td><Link to={`/alerts/${al.alertId}`}>{al.service}</Link></td>
                      <td>{al.anomalyType}</td>
                      <td><StatusBadge status={al.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>
    ),
    'recent-analyses': () => (
      <Card title="Recent AI Analyses" actions={<Link to="/ai">View all</Link>}>
        <AsyncView state={analyses}>
          {(an) => an.data.items.length === 0 ? (
            <p className="text-secondary">No analyses yet. Trigger one from AI Insights.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Service</th><th>Anomaly</th><th>Conf.</th><th>Time</th></tr></thead>
                <tbody>
                  {an.data.items.slice(0, 5).map((a) => (
                    <tr key={a.id}>
                      <td>{a.service}</td>
                      <td>{a.anomalyType ?? <span className="text-muted">NO_ANOMALY</span>}</td>
                      <td><Confidence value={a.confidence} /></td>
                      <td className="cell-mono">{fmtTime(a.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>
    ),
  };

  const visible = shown.widgets.filter((w) => w.visible && widgets[w.id]);
  const hidden = shown.widgets.filter((w) => !w.visible && widgets[w.id]);

  return (
    <div className="stack">
      <PageHeader
        title="Dashboard"
        subtitle="Proactive observability overview"
        source={(summary.data?.source ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'}
        actions={
          editing ? (
            <div className="row dash-customize-bar">
              {dirty && <span className="dash-unsaved" role="status">Unsaved changes</span>}
              <Button variant="ghost" onClick={onReset} disabled={saving}>Reset to default</Button>
              <Button variant="secondary" onClick={cancel} disabled={saving}>Cancel</Button>
              <Button onClick={onSave} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={startEdit} aria-label="Customize dashboard">Customize</Button>
          )
        }
      />
      <div className="sr-only" role="status" aria-live="polite" data-testid="dash-live">{announce}</div>
      {error && <p role="alert" style={{ color: 'var(--color-danger)', margin: 0 }}>{error}</p>}
      <div className="banner">
        <span className="banner-icon"><IconWarn size={16} /></span>
        <span>
          <strong>Mixed data sources.</strong> Logs, alerts, and the AI assistant are
          live from the Urbani AWS backend (Bedrock Nova 2 Lite). Metrics, services, usage,
          and audit remain seeded until their AWS endpoints are provided. Every panel is
          labelled with its true source: <span className="src src-LIVE">LIVE</span>{' '}
          <span className="src src-MOCK">MOCK</span> <span className="src src-WAITING_FOR_INTEGRATION">WAITING</span>.
        </span>
      </div>
      {editing && (
        <p className="text-secondary" style={{ margin: 0, fontSize: 13 }}>
          Customize mode: drag a widget by its handle, or use the move up / move down buttons. Use Hide to move a widget to the tray.
          {isCustom ? '' : ' You are using the default layout.'}
        </p>
      )}
      <div className="dash-widgets" data-testid="dash-widgets">
        {visible.map((w, idx) => {
          const def = WIDGET_BY_ID.get(w.id)!;
          const body = widgets[w.id]();
          if (!editing) return <div key={w.id} className={`dash-widget dash-${def.size}`} data-widget={w.id}>{body}</div>;
          return (
            <div
              key={w.id}
              className={`dash-widget dash-frame dash-${def.size} ${overId === w.id ? 'dash-over' : ''}`}
              data-widget={w.id}
              draggable={dragReady === w.id}
              onDragStart={(e) => { dragId.current = w.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', w.id); }}
              onDragOver={(e) => { if (dragId.current) { e.preventDefault(); setOverId(w.id); } }}
              onDragLeave={() => setOverId((o) => (o === w.id ? null : o))}
              onDrop={(e) => { e.preventDefault(); if (dragId.current) moveTo(dragId.current, w.id); dragId.current = null; setOverId(null); setDragReady(null); }}
              onDragEnd={() => { dragId.current = null; setOverId(null); setDragReady(null); }}
            >
              <div className="dash-toolbar" role="group" aria-label={`${def.title} controls`}>
                <span
                  className="dash-handle"
                  title="Drag to reorder"
                  aria-hidden="true"
                  onMouseDown={() => setDragReady(w.id)}
                  onMouseUp={() => setDragReady(null)}
                >⠿</span>
                <strong className="dash-toolbar-title">{def.title}</strong>
                <span className="dash-toolbar-actions">
                  <Button size="sm" variant="secondary" onClick={() => move(w.id, -1)} disabled={idx === 0}
                    aria-label={`Move ${def.title} up`}>↑</Button>
                  <Button size="sm" variant="secondary" onClick={() => move(w.id, 1)} disabled={idx === visible.length - 1}
                    aria-label={`Move ${def.title} down`}>↓</Button>
                  <Button size="sm" variant="secondary" onClick={() => setVisible(w.id, false)} aria-label={`Hide ${def.title}`}>Hide</Button>
                </span>
              </div>
              <div className="dash-frame-body">{body}</div>
            </div>
          );
        })}
      </div>
      {editing && (
        <section className="card dash-tray" aria-label="Hidden widgets">
          <div className="card-title"><span>Hidden widgets</span></div>
          {hidden.length === 0 ? (
            <p className="text-secondary" style={{ margin: 0 }}>No hidden widgets.</p>
          ) : (
            <ul className="dash-tray-list">
              {hidden.map((w) => (
                <li key={w.id}>
                  <span>{titleOf(w.id)}</span>
                  <Button size="sm" variant="secondary" onClick={() => setVisible(w.id, true)} aria-label={`Show ${titleOf(w.id)}`}>Show</Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
