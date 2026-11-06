import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { logsApi, servicesApi, type LogQueryParams } from '../api/endpoints';
import {
  PageHeader, Card, FilterBar, SearchInput, Select, Button, AsyncView, SkeletonTable, Pagination, fmtTime,
} from '../components/ui';
import { ExportMenu } from '../components/ExportMenu';
import { useAuth } from '../auth/AuthContext';

const PAGE_SIZE = 50;
const EXPORT_NOTE_ROWS = '10,000';
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
const DEBOUNCE_MS = 400;

const LEVEL_COLOR: Record<string, string> = {
  ERROR: 'var(--color-danger)', FATAL: 'var(--color-danger)',
  WARN: 'var(--color-warning)', INFO: 'var(--color-text-secondary)',
  DEBUG: 'var(--color-text-muted)',
};

/** ISO <-> <input type="datetime-local"> (local time) helpers. */
const toLocalInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string): string => (v ? new Date(v).toISOString() : '');

function regexError(pattern: string): string | null {
  if (!pattern) return null;
  if (pattern.length > 200) return 'Regex is too long (max 200 characters).';
  try { new RegExp(pattern, 'i'); return null; } catch (e) { return e instanceof Error ? e.message : 'Invalid regular expression'; }
}

/** Logs module: severity / server / date-range / text / regex filters, URL-synced and shareable. */
export function Logs() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();

  // Applied filters live in the URL so a filtered view can be bookmarked or shared.
  const applied = useMemo(() => ({
    levels: (params.get('levels') ?? '').split(',').filter(Boolean),
    service: params.get('services') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    search: params.get('search') ?? '',
    regex: params.get('regex') === 'true',
    sort: (params.get('sort') === 'oldest' ? 'oldest' : 'newest') as 'newest' | 'oldest',
    page: Math.max(Number(params.get('page')) || 1, 1),
  }), [params]);

  const update = (patch: Partial<Record<string, string | null>>, keepPage = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    if (!keepPage) next.delete('page');
    setParams(next, { replace: true });
  };

  // Draft inputs (applied on Apply, or after the debounce for the text box).
  const [levels, setLevels] = useState<string[]>(applied.levels);
  const [service, setService] = useState(applied.service);
  const [from, setFrom] = useState(toLocalInput(applied.from || null));
  const [to, setTo] = useState(toLocalInput(applied.to || null));
  const [text, setText] = useState(applied.search);
  const [regex, setRegex] = useState(applied.regex);

  const rxError = regex ? regexError(text) : null;
  const rangeError = from && to && new Date(from) > new Date(to) ? 'From must not be after To.' : null;

  // Debounced text/regex commit (only when valid).
  useEffect(() => {
    if (text === applied.search && regex === applied.regex) return;
    if (rxError) return;
    const t = setTimeout(() => update({ search: text, regex: regex && text ? 'true' : null }), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, regex, rxError]);

  const apply = () => {
    if (rxError || rangeError) return;
    update({
      levels: levels.join(','), services: service, from: fromLocalInput(from), to: fromLocalInput(to),
      search: text, regex: regex && text ? 'true' : null,
    });
  };
  const reset = () => {
    setLevels([]); setService(''); setFrom(''); setTo(''); setText(''); setRegex(false);
    setParams(new URLSearchParams(), { replace: true });
  };
  const toggleLevel = (l: string) => setLevels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

  const services = useApi(() => servicesApi.list(), []);
  const query: LogQueryParams = {
    levels: applied.levels.join(','), services: applied.service, from: applied.from, to: applied.to,
    search: applied.search, regex: applied.regex || undefined, sort: applied.sort, page: applied.page, pageSize: PAGE_SIZE,
  };
  const logs = useApi(() => logsApi.list(query), [params.toString()]);

  const chips: { key: string; label: string; clear: () => void }[] = [];
  applied.levels.forEach((l) => chips.push({ key: `l-${l}`, label: `Level: ${l}`, clear: () => { setLevels(applied.levels.filter((x) => x !== l)); update({ levels: applied.levels.filter((x) => x !== l).join(',') }); } }));
  if (applied.service) chips.push({ key: 'svc', label: `Server: ${applied.service}`, clear: () => { setService(''); update({ services: null }); } });
  if (applied.from) chips.push({ key: 'from', label: `From: ${fmtTime(applied.from)}`, clear: () => { setFrom(''); update({ from: null }); } });
  if (applied.to) chips.push({ key: 'to', label: `To: ${fmtTime(applied.to)}`, clear: () => { setTo(''); update({ to: null }); } });
  if (applied.search) chips.push({ key: 'q', label: `${applied.regex ? 'Regex' : 'Text'}: ${applied.search}`, clear: () => { setText(''); setRegex(false); update({ search: null, regex: null }); } });

  const meta = logs.data?.meta;
  // Export uses exactly the applied filters (page / pageSize are ignored by the API).
  const exportPath = (format: string) => {
    const q = new URLSearchParams({ format });
    if (applied.levels.length) q.set('levels', applied.levels.join(','));
    if (applied.service) q.set('services', applied.service);
    if (applied.from) q.set('from', applied.from);
    if (applied.to) q.set('to', applied.to);
    if (applied.search) q.set('search', applied.search);
    if (applied.regex) q.set('regex', 'true');
    q.set('sort', applied.sort);
    return `/logs/export?${q.toString()}`;
  };
  const serverError = logs.error && applied.regex ? logs.error : null;

  return (
    <div className="stack">
      <PageHeader
        title="Logs"
        subtitle="Search Urbani logs by severity, server, date range, text or regex."
        source={(logs.data?.source ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'}
        actions={can('logs:export') ? (
          <ExportMenu formats={['csv', 'json', 'pdf']} buildPath={(f) => exportPath(f)}
            note={`Exports up to ${EXPORT_NOTE_ROWS} rows of the current filtered view (scope: ${meta?.scope ?? 'configured log source'}). PDF is limited to the first 2,000 rows.`} />
        ) : undefined}
      />
      <Card>
        <FilterBar>
          <SearchInput placeholder={regex ? 'Regular expression…' : 'Search message…'} value={text}
            onChange={(e) => setText(e.target.value)} aria-label="Search logs" aria-invalid={!!rxError}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />
          <label className="text-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regex
          </label>
          <Select value={service} onChange={(e) => setService(e.target.value)} aria-label="Filter by server">
            <option value="">All servers</option>
            {services.data?.data.filter((s) => s.enabled !== false).map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </Select>
          <input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date and time" />
          <input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date and time" />
        </FilterBar>
        <FilterBar>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <legend className="text-secondary" style={{ fontSize: 12 }}>Severity</legend>
            {LEVELS.map((l) => (
              <label key={l} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', color: LEVEL_COLOR[l] }}>
                <input type="checkbox" checked={levels.includes(l)} onChange={() => toggleLevel(l)} /> {l}
              </label>
            ))}
          </fieldset>
          <Button onClick={apply} disabled={!!rxError || !!rangeError}>Apply</Button>
          <Button variant="secondary" onClick={reset}>Reset</Button>
          <Button variant="ghost" onClick={() => update({ sort: applied.sort === 'newest' ? 'oldest' : null }, true)}
            aria-label="Toggle sort order">Sort: {applied.sort === 'newest' ? 'Newest first' : 'Oldest first'}</Button>
        </FilterBar>
        {(rxError || rangeError || serverError) && (
          <p role="alert" style={{ color: 'var(--color-danger)', margin: '0 0 var(--space-3)' }}>{rxError ?? rangeError ?? serverError}</p>
        )}
        {chips.length > 0 && (
          <div className="chat-suggestions" aria-label="Active filters">
            {chips.map((c) => (
              <button key={c.key} type="button" className="chat-chip" onClick={c.clear} title="Remove filter">{c.label} ×</button>
            ))}
          </div>
        )}

        {meta && (
          <div className="text-secondary" style={{ fontSize: 12, marginBottom: 'var(--space-3)' }}>
            <div>
              {meta.total} matching line{meta.total === 1 ? '' : 's'} in the scanned window
              {meta.truncated && ` · window cap of ${meta.windowCap} lines reached, more matching lines may exist outside it`}
            </div>
            <div>Scope: {meta.scope}</div>
          </div>
        )}

        {logs.loading && !logs.data ? <SkeletonTable rows={10} cols={4} /> : serverError ? null : (
          <AsyncView state={logs}>
            {(l) => l.data.items.length === 0 ? (
              l.source === 'WAITING_FOR_INTEGRATION' ? (
                <p className="text-secondary" style={{ padding: 'var(--space-4)' }}>
                  Live logs temporarily unavailable — no recent window available. Try again shortly.
                  {l.sourceNote ? ` ${l.sourceNote}` : ''}
                </p>
              ) : (
                <p className="text-secondary" style={{ padding: 'var(--space-4)' }}>No log entries match these filters.</p>
              )
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th style={{ width: 180 }}>Time</th><th style={{ width: 90 }}>Level</th><th style={{ width: 160 }}>Server</th><th>Message</th></tr></thead>
                    <tbody>
                      {l.data.items.map((e) => (
                        <tr key={e.id}>
                          <td>{fmtTime(e.timestamp)}</td>
                          <td style={{ color: LEVEL_COLOR[e.level] ?? 'inherit', fontWeight: 600 }}>{e.level}</td>
                          <td>{e.service}</td>
                          <td className="cell-mono">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={applied.page} total={l.data.total} pageSize={PAGE_SIZE}
                  onPage={(p) => update({ page: p > 1 ? String(p) : null }, true)} />
              </>
            )}
          </AsyncView>
        )}
      </Card>
    </div>
  );
}
