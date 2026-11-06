import { useEffect, useRef, useState } from 'react';
import { downloadFile, saveBlob, exportErrorMessage } from '../api/client';
import { Button } from './ui';

export type ExportFormat = 'csv' | 'json' | 'pdf';
const LABEL: Record<ExportFormat, string> = { csv: 'CSV', json: 'JSON', pdf: 'PDF' };

/**
 * Export dropdown (DPI 2 item 11). `buildPath(format)` returns the API path + current filters. Keyboard: Escape closes,
 * arrow keys move between items. The button is disabled while an export runs; results/errors are announced.
 */
export function ExportMenu({
  formats,
  buildPath,
  note,
  label = 'Export',
}: {
  formats: ExportFormat[];
  buildPath: (format: ExportFormat) => string;
  note?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const run = async (format: ExportFormat) => {
    setOpen(false);
    setBusy(format);
    setMessage(null);
    try {
      const r = await downloadFile(buildPath(format));
      saveBlob(r.blob, r.filename);
      setMessage({
        kind: 'ok',
        text: `${r.filename} downloaded${r.rows !== null && format !== 'pdf' ? ` (${r.rows} rows)` : ''}${r.truncated ? '. The export is truncated: see the notice inside the file.' : '.'}`,
      });
    } catch (e) {
      setMessage({ kind: 'error', text: exportErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  };

  return (
    <div className="export-menu" ref={root} onKeyDown={onKeyDown}>
      <Button
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy !== null}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? `Exporting ${LABEL[busy]}…` : `${label} ▾`}
      </Button>
      {open && (
        <div className="export-menu-list" role="menu" aria-label={label}>
          {formats.map((f) => (
            <button key={f} type="button" role="menuitem" className="export-menu-item" onClick={() => void run(f)}>
              {LABEL[f]}
            </button>
          ))}
        </div>
      )}
      {note && <div className="text-secondary export-menu-note">{note}</div>}
      <div role={message?.kind === 'error' ? 'alert' : 'status'} aria-live="polite" className="export-menu-msg"
        style={{ color: message?.kind === 'error' ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>
        {message?.text ?? ''}
      </div>
    </div>
  );
}

/** Download a single file from a button (incident report). */
export function DownloadButton({ path, children }: { path: string; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await downloadFile(path);
            saveBlob(r.blob, r.filename);
          } catch (e) {
            setError(exportErrorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Preparing…' : children}
      </Button>
      <span role="alert" style={{ color: 'var(--color-danger)', fontSize: 12, marginLeft: 8 }}>{error ?? ''}</span>
    </span>
  );
}
