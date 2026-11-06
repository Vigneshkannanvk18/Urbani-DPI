import type { Writable } from 'node:stream';

/**
 * CSV + JSON streaming writers (DPI 2 item 11; docs/EXPORT.md). Rows are serialised and written one at a time
 * with back-pressure (`drain`), so the full text is never held in memory. The caller owns the row source.
 */
export const CSV_BOM = '\uFEFF';
export const CRLF = '\r\n';

/** Cells starting with one of these are prefixed with a single quote (CSV / formula injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Neutralise spreadsheet formulas. Only strings are touched. */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** RFC 4180 cell: formula-neutralised, quoted when it holds a comma, quote, CR or LF; quotes doubled. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? neutralizeFormula(value) : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',') + CRLF;
}

/** Thrown when the client went away or the deadline passed, so callers stop producing rows. */
export class ExportAbortedError extends Error {
  constructor(message = 'Export aborted') {
    super(message);
  }
}

async function write(out: Writable, chunk: string): Promise<void> {
  if (out.destroyed || out.writableEnded) throw new ExportAbortedError();
  if (out.write(chunk)) return;
  // Back-pressure: wait for drain; listeners are removed so thousands of waits never pile up on the socket.
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      out.off('drain', onDrain);
      out.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ExportAbortedError());
    };
    out.once('drain', onDrain);
    out.once('close', onClose);
  });
}
/** Batch several small rows per write call to keep syscalls reasonable, still bounded (<= ~16 KB). */
const FLUSH_BYTES = 16 * 1024;

export async function writeCsv<T>(
  out: Writable,
  columns: readonly string[],
  rows: Iterable<T> | AsyncIterable<T>,
  toCells: (row: T) => readonly unknown[],
  opts: { bom?: boolean } = {},
): Promise<void> {
  let buf = (opts.bom === false ? '' : CSV_BOM) + csvLine(columns);
  for await (const row of rows as AsyncIterable<T>) {
    buf += csvLine(toCells(row));
    if (buf.length >= FLUSH_BYTES) {
      await write(out, buf);
      buf = '';
    }
  }
  if (buf) await write(out, buf);
  out.end();
}

export async function writeJson<T>(
  out: Writable,
  meta: unknown,
  rows: Iterable<T> | AsyncIterable<T>,
): Promise<void> {
  let buf = `{"meta":${JSON.stringify(meta)},"items":[`;
  let first = true;
  for await (const row of rows as AsyncIterable<T>) {
    buf += (first ? '' : ',') + JSON.stringify(row);
    first = false;
    if (buf.length >= FLUSH_BYTES) {
      await write(out, buf);
      buf = '';
    }
  }
  buf += ']}';
  await write(out, buf);
  out.end();
}

/** UTC yyyymmdd-HHmmss for file names. */
export function utcStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** urbani-<kind>-<UTC stamp>.<ext>, with the kind reduced to a safe alphabet. */
export function exportFileName(kind: string, ext: string, d = new Date()): string {
  const safe = kind.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'export';
  return `urbani-${safe}-${utcStamp(d)}.${ext}`;
}
