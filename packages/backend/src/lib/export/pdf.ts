import type { Writable } from 'node:stream';
import type { LogEntry, PersistedAlert } from '@urbani/shared';

// pdfkit ships no bundled types and the project does not add @types for it; the surface used here is small.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

/**
 * PDF writers (DPI 2 item 11; docs/EXPORT.md). Lessons from scripts/gen-docs.js: text is measured BEFORE drawing
 * and pages are broken deliberately, the bottom margin is tiny so footer text near the page edge can never
 * auto-create a blank page, pages are buffered and footers are stamped in a final pass, and only the standard
 * Helvetica/Courier fonts are used (so text is reduced to what WinAnsi can show; Spanish accents are kept).
 */
export const BRAND_NAME = 'Urbani Observability';

const W = 595.28;
const H = 841.89;
const M = 40;
const CONTENT_W = W - M * 2;
const BOTTOM_LIMIT = H - 50; // content never goes below this; the footer lives below it
const MAX_MESSAGE_CHARS = 600;

const COLORS = {
  text: '#1f2937',
  muted: '#6b7280',
  line: '#d1d5db',
  head: '#111827',
  zebra: '#f3f4f6',
  accent: '#0b5cad',
  warn: '#b45309',
  ERROR: '#b91c1c',
  FATAL: '#b91c1c',
  WARN: '#b45309',
  INFO: '#374151',
  DEBUG: '#6b7280',
};
const BADGE: Record<string, string> = {
  CRITICAL: '#b91c1c', HIGH: '#c2410c', MEDIUM: '#a16207', LOW: '#1d4ed8',
  OPEN: '#b91c1c', ACKNOWLEDGED: '#a16207', RESOLVED: '#15803d', DISMISSED: '#6b7280',
  LIVE: '#15803d', MOCK: '#6b7280', WAITING_FOR_INTEGRATION: '#a16207',
};

const REPLACEMENTS: Record<string, string> = {
  '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
  '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u2022': '*', '\u00B7': '-', '\u2713': 'ok', '\u2715': 'x',
  '\u20AC': 'EUR', '\u2122': '(TM)',
};

/** Reduce text to glyphs the standard Helvetica (WinAnsi/Latin-1) font can draw. Accents stay. */
export function pdfText(input: string): string {
  return String(input)
    .replace(/[\u2192\u2190\u2194\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u2022\u00B7\u2713\u2715\u20AC\u2122]/g, (c) => REPLACEMENTS[c])
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/gu, '?');
}

/** Message cell text: ellipsis marker when absurdly long, and long unbroken tokens get break points. */
export function pdfMessage(input: string, maxChars = MAX_MESSAGE_CHARS): string {
  const raw = String(input);
  const cut = raw.length > maxChars ? `${raw.slice(0, maxChars - 20)} ... [truncated]` : raw;
  return pdfText(cut).replace(/(\S{50})(?=\S)/g, '$1 ');
}

export interface PdfListMeta {
  title: string;
  /** Source label: LIVE | MOCK | WAITING_FOR_INTEGRATION. */
  source: string;
  sourceNote?: string;
  scope: string;
  filters: Record<string, unknown>;
  /** Rows in the file (after caps). */
  rowCount: number;
  truncated: boolean;
  truncationNotice?: string;
  generatedAt: string;
  generatedBy: string;
}

export interface PdfResult {
  pages: number;
  /** Everything drawn on the cover block (for tests). */
  cover: string[];
}

function describeFilters(filters: Record<string, unknown>): string {
  const parts = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
  return parts.length ? parts.join('; ') : 'none (all available rows)';
}

class Pdf {
  doc: any;
  y = M;
  readonly drawn: string[] = [];
  private done: Promise<void>;
  constructor(out: Writable, private footerLeft: string, compress: boolean) {
    this.doc = new PDFDocument({
      size: 'A4',
      margins: { top: M, bottom: 8, left: M, right: M },
      bufferPages: true,
      compress,
      info: { Title: footerLeft, Creator: BRAND_NAME, Producer: BRAND_NAME },
    });
    this.done = new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('close', resolve);
      out.on('error', reject);
    });
    this.doc.pipe(out);
  }

  font(name: 'Helvetica' | 'Helvetica-Bold' | 'Courier', size: number, color = COLORS.text): void {
    this.doc.font(name).fontSize(size).fillColor(color);
  }
  height(text: string, width: number, lineGap = 1): number {
    return this.doc.heightOfString(text, { width, lineGap });
  }
  /** Start a new page when `h` does not fit. Returns true if a page was added. */
  ensure(h: number, onNewPage?: () => void): boolean {
    if (this.y + h <= BOTTOM_LIMIT) return false;
    this.doc.addPage();
    this.y = M;
    onNewPage?.();
    return true;
  }
  /** Measured paragraph at the left margin. */
  para(text: string, opts: { size?: number; bold?: boolean; color?: string; mono?: boolean; gap?: number; indent?: number; track?: boolean } = {}): void {
    const t = pdfText(text);
    const size = opts.size ?? 10;
    this.font(opts.mono ? 'Courier' : opts.bold ? 'Helvetica-Bold' : 'Helvetica', size, opts.color);
    const x = M + (opts.indent ?? 0);
    const w = CONTENT_W - (opts.indent ?? 0);
    const h = this.height(t, w);
    this.ensure(h);
    this.doc.text(t, x, this.y, { width: w, lineGap: 1 });
    this.y += h + (opts.gap ?? 4);
    if (opts.track) this.drawn.push(t);
  }
  kv(key: string, value: string, track = false): void {
    const kw = 105;
    const t = pdfText(value);
    this.font('Helvetica', 9);
    const h = Math.max(this.height(t, CONTENT_W - kw), 11);
    this.ensure(h);
    this.font('Helvetica-Bold', 9, COLORS.muted);
    this.doc.text(pdfText(key), M, this.y, { width: kw - 6, lineBreak: false });
    this.font('Helvetica', 9);
    this.doc.text(t, M + kw, this.y, { width: CONTENT_W - kw, lineGap: 1 });
    this.y += h + 3;
    if (track) this.drawn.push(`${key}: ${t}`);
  }
  badge(label: string, x: number, y: number): number {
    const t = pdfText(label);
    this.font('Helvetica-Bold', 8, '#ffffff');
    const w = this.doc.widthOfString(t) + 12;
    this.doc.roundedRect(x, y, w, 14, 3).fill(BADGE[label.split(':').pop()!.trim()] ?? COLORS.muted);
    this.doc.fillColor('#ffffff').text(t, x + 6, y + 3.5, { width: w, lineBreak: false });
    return w;
  }
  rule(): void {
    this.doc.moveTo(M, this.y).lineTo(W - M, this.y).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    this.y += 6;
  }
  heading(text: string): void {
    this.ensure(30);
    this.y += 4;
    this.para(text, { size: 12, bold: true, color: COLORS.head, gap: 4 });
  }

  /** Footers in a final pass, then close. */
  async finish(): Promise<number> {
    const range = this.doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);
      this.font('Helvetica', 8, COLORS.muted);
      this.doc.text(`${pdfText(this.footerLeft)}   |   Page ${i + 1} of ${range.count}`, M, H - 32, {
        width: CONTENT_W,
        align: 'center',
        lineBreak: false,
      });
    }
    this.doc.end();
    await this.done;
    return range.count;
  }
}

function cover(p: Pdf, m: PdfListMeta): string[] {
  p.para(BRAND_NAME, { size: 9, bold: true, color: COLORS.accent, gap: 2 });
  p.para(m.title, { size: 20, bold: true, color: COLORS.head, gap: 6 });
  p.badge(`SOURCE: ${m.source}`, M, p.y);
  p.y += 22;
  if (m.sourceNote) p.para(m.sourceNote, { size: 8, color: COLORS.muted, gap: 6, track: true });
  p.rule();
  p.kv('Generated (UTC)', m.generatedAt, true);
  p.kv('Generated by', m.generatedBy, true);
  p.kv('Rows in this file', String(m.rowCount), true);
  p.kv('Scope', m.scope, true);
  p.kv('Filters', describeFilters(m.filters), true);
  if (m.truncated) {
    p.y += 2;
    p.para(m.truncationNotice ?? 'NOTICE: this export is truncated; more matching rows may exist.', {
      size: 9, bold: true, color: COLORS.warn, gap: 6, track: true,
    });
  }
  p.rule();
  return p.drawn;
}

/** Logs table PDF: cover block, then timestamp | level | service | message with a repeating header. */
export async function writeLogsPdf(
  out: Writable,
  meta: PdfListMeta,
  rows: readonly LogEntry[],
  opts: { compress?: boolean } = {},
): Promise<PdfResult> {
  const p = new Pdf(out, `${BRAND_NAME} - ${meta.title}`, opts.compress !== false);
  const coverLines = cover(p, meta);
  const cols = { ts: 118, lvl: 40, svc: 80 };
  const msgW = CONTENT_W - cols.ts - cols.lvl - cols.svc - 8;
  const xTs = M + 4;
  const xLvl = xTs + cols.ts;
  const xSvc = xLvl + cols.lvl;
  const xMsg = xSvc + cols.svc;
  const header = () => {
    p.doc.rect(M, p.y, CONTENT_W, 16).fill(COLORS.head);
    p.font('Helvetica-Bold', 8, '#ffffff');
    p.doc.text('Timestamp (UTC)', xTs, p.y + 4.5, { width: cols.ts, lineBreak: false });
    p.doc.text('Level', xLvl, p.y + 4.5, { width: cols.lvl, lineBreak: false });
    p.doc.text('Service', xSvc, p.y + 4.5, { width: cols.svc, lineBreak: false });
    p.doc.text('Message', xMsg, p.y + 4.5, { width: msgW, lineBreak: false });
    p.y += 18;
  };
  if (rows.length === 0) {
    p.para('No rows matched. Nothing was fabricated to fill this report.', { size: 10, color: COLORS.muted });
  } else {
    p.ensure(40);
    header();
    rows.forEach((r, i) => {
      const msg = pdfMessage(r.message);
      p.font('Helvetica', 7.5);
      const rowH = Math.max(p.height(msg, msgW, 0.5), 9) + 5;
      p.ensure(rowH, header);
      if (i % 2 === 1) p.doc.rect(M, p.y - 1, CONTENT_W, rowH).fill(COLORS.zebra);
      p.font('Helvetica', 7.5);
      p.doc.text(pdfText(r.timestamp), xTs, p.y + 1.5, { width: cols.ts, lineBreak: false });
      p.font('Helvetica-Bold', 7.5, (COLORS as Record<string, string>)[r.level] ?? COLORS.text);
      p.doc.text(pdfText(r.level), xLvl, p.y + 1.5, { width: cols.lvl, lineBreak: false });
      p.font('Helvetica', 7.5);
      p.doc.text(pdfText(r.service), xSvc, p.y + 1.5, { width: cols.svc - 4, lineBreak: false, ellipsis: true });
      p.doc.text(msg, xMsg, p.y + 1.5, { width: msgW, lineGap: 0.5 });
      p.y += rowH;
    });
  }
  const pages = await p.finish();
  return { pages, cover: coverLines };
}

export interface IncidentReport {
  alert: PersistedAlert;
  relatedLogs: LogEntry[];
  source: string;
  sourceNote?: string;
  generatedAt: string;
  generatedBy: string;
  /** True when the confidence value was derived from severity (live QA gives none). */
  confidenceDerived: boolean;
}

/** Single-incident PDF. */
export async function writeIncidentPdf(out: Writable, r: IncidentReport, opts: { compress?: boolean } = {}): Promise<PdfResult> {
  const a = r.alert;
  const p = new Pdf(out, `${BRAND_NAME} - Incident ${a.alertId}`, opts.compress !== false);
  p.para(BRAND_NAME, { size: 9, bold: true, color: COLORS.accent, gap: 2 });
  p.para('Incident report', { size: 20, bold: true, color: COLORS.head, gap: 2 });
  p.para(a.anomalyType, { size: 12, bold: true, gap: 2 });
  p.para(a.alertId, { size: 9, mono: true, color: COLORS.muted, gap: 6 });
  let x = M;
  x += p.badge(`SOURCE: ${r.source}`, x, p.y) + 6;
  x += p.badge(a.severity, x, p.y) + 6;
  p.badge(a.status, x, p.y);
  p.y += 22;
  if (r.sourceNote) p.para(r.sourceNote, { size: 8, color: COLORS.muted, gap: 4 });
  p.rule();
  p.kv('Detected', a.timestamp);
  p.kv('Service', a.service);
  p.kv('Environment', a.environment);
  p.kv('Model', a.modelId);
  const conf =
    a.confidence == null
      ? 'Not provided by the source'
      : `${Math.round(a.confidence * 100)}%${r.confidenceDerived ? ' (derived from severity; the source supplies no model score)' : ''}`;
  p.kv('AI confidence', conf);
  if (a.acknowledgedBy) p.kv('Acknowledged', `${a.acknowledgedBy} at ${a.acknowledgedAt ?? 'unknown time'}`);
  else p.kv('Acknowledged', 'Not acknowledged');
  p.heading('Summary');
  p.para(a.summary);
  p.heading('Probable cause');
  p.para(a.probableCause);
  p.heading('Recommended actions (advisory, human review required)');
  if (a.recommendedActions.length === 0) p.para('None provided.', { color: COLORS.muted });
  a.recommendedActions.forEach((s, i) => p.para(`${i + 1}. ${s}`, { indent: 8, gap: 3 }));
  p.heading('Correlated evidence (log lines)');
  if (a.evidence.length === 0) p.para('No log evidence was correlated for this incident.', { color: COLORS.muted });
  a.evidence.forEach((line) => p.para(pdfMessage(line, 800), { size: 7.5, mono: true, indent: 8, gap: 3 }));
  p.heading('Related logs');
  if (r.relatedLogs.length === 0) p.para('No related logs linked.', { color: COLORS.muted });
  r.relatedLogs.forEach((l) => p.para(`${l.timestamp}  ${l.level}  ${l.service}  ${pdfMessage(l.message, 400)}`, { size: 7.5, mono: true, indent: 8, gap: 3 }));
  p.heading('Generated');
  p.kv('Generated (UTC)', r.generatedAt);
  p.kv('Generated by', r.generatedBy);
  p.para('This report is advisory. The platform never performs automated remediation.', { size: 8, color: COLORS.muted });
  const pages = await p.finish();
  return { pages, cover: p.drawn };
}
