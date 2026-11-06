import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { LogEntry, PersistedAlert } from '@urbani/shared';
import { pdfMessage, pdfText, writeIncidentPdf, writeLogsPdf, type PdfListMeta } from './pdf';

async function collect(run: (out: PassThrough) => Promise<{ pages: number; cover: string[] }>) {
  const out = new PassThrough();
  const parts: Buffer[] = [];
  out.on('data', (c) => parts.push(c));
  const res = await run(out);
  return { ...res, buf: Buffer.concat(parts) };
}
const pageObjects = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page(?![s\w])/g) ?? []).length;

const meta = (over: Partial<PdfListMeta> = {}): PdfListMeta => ({
  title: 'Log export', source: 'MOCK', sourceNote: 'Seeded demonstration data', scope: 'latest + history window and incident evidence',
  filters: { levels: ['ERROR'], search: 'timeout' }, rowCount: 0, truncated: false,
  generatedAt: '2026-11-07T09:00:00.000Z', generatedBy: 'admin@urbani.test', ...over,
});
const rows = (n: number, message = (i: number) => `línea ${i}: conexión rechazada – año`): LogEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `l${i}`, timestamp: `2026-11-07T09:00:${String(i % 60).padStart(2, '0')}.000Z`, level: i % 2 ? 'ERROR' : 'INFO',
    service: 'main', environment: 'qa', message: message(i),
  }));

describe('pdf text helpers', () => {
  it('keeps Spanish accents and replaces glyphs Helvetica lacks', () => {
    expect(pdfText('conexión → año ñ ü “q”')).toBe('conexión -> año ñ ü "q"');
    expect(pdfText('emoji 😀 ok')).toBe('emoji ? ok');
    expect(pdfText('a\u0000b\nc')).toBe('a b c');
  });
  it('truncates absurdly long messages with an ellipsis marker and breaks long tokens', () => {
    const long = pdfMessage('x'.repeat(2000));
    expect(long.length).toBeLessThan(700);
    expect(long).toContain('[truncated]');
    expect(pdfMessage('a'.repeat(120))).toContain(' ');
  });
});

describe('writeLogsPdf', () => {
  it('produces a valid PDF whose page count equals the number of /Type /Page objects (no phantom pages)', async () => {
    for (const n of [0, 1, 40, 400]) {
      const { buf, pages } = await collect((o) => writeLogsPdf(o, meta({ rowCount: n }), rows(n)));
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(buf.subarray(-6).toString()).toContain('%%EOF');
      expect(pages, `rows=${n}`).toBeGreaterThanOrEqual(1);
      expect(pageObjects(buf), `rows=${n}`).toBe(pages);
    }
  });

  it('has more pages for more rows and handles Spanish accents, a truncation notice and 2000-char messages', async () => {
    const small = await collect((o) => writeLogsPdf(o, meta({ rowCount: 5 }), rows(5)));
    const big = await collect((o) =>
      writeLogsPdf(o, meta({ rowCount: 300, truncated: true, truncationNotice: 'NOTICE: PDF exports are limited to 300 rows' }), rows(300, (i) => (i === 3 ? 'z'.repeat(2000) : `acción ${i} ñandú`)), {
      }),
    );
    expect(big.pages).toBeGreaterThan(small.pages);
    expect(pageObjects(big.buf)).toBe(big.pages);
    expect(big.cover.join('\n')).toContain('NOTICE: PDF exports are limited to 300 rows');
    expect(big.cover.join('\n')).toContain('latest + history window and incident evidence');
    expect(big.cover.join('\n')).toContain('levels: ERROR');
    // WinAnsi font encoding for the standard fonts
    expect(big.buf.toString('latin1')).toContain('/WinAnsiEncoding');
  });

});

describe('writeIncidentPdf', () => {
  const alert: PersistedAlert = {
    alertId: 'A-1', timestamp: '2026-11-07T08:00:00.000Z', service: 'main', environment: 'qa', severity: 'HIGH',
    anomalyType: 'HTTP_500', summary: 'Aumento de errores 500', evidence: ['ERROR conexión rechazada', 'x'.repeat(3000)],
    probableCause: 'Base de datos saturada', recommendedActions: ['Revisar conexiones', 'Reiniciar tras revisión humana'],
    confidence: 0.8, modelId: 'nova', status: 'OPEN', acknowledgedBy: null, acknowledgedAt: null, relatedLogIds: [], relatedMetricIds: [],
  };
  it('renders a single-incident PDF without phantom pages', async () => {
    const { buf, pages } = await collect((o) =>
      writeIncidentPdf(o, { alert, relatedLogs: rows(60), source: 'LIVE', generatedAt: '2026-11-07T09:00:00.000Z', generatedBy: 'a@b.c', confidenceDerived: true }),
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageObjects(buf)).toBe(pages);
    expect(pages).toBeGreaterThanOrEqual(1);
  });
});
