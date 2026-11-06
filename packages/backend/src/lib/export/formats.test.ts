import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { csvCell, csvLine, neutralizeFormula, writeCsv, writeJson, exportFileName, utcStamp, CSV_BOM } from './formats';

/** Collects what was written and how (chunk count / largest chunk), honouring back-pressure like a socket. */
function sink(highWaterMark = 1024) {
  const chunks: string[] = [];
  let pending = 0;
  let maxPending = 0;
  const w = new Writable({
    highWaterMark,
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      pending = Math.max(pending, w.writableLength);
      maxPending = Math.max(maxPending, pending);
      setImmediate(cb); // slow consumer
    },
  });
  return { w, chunks, get maxBuffered() { return maxPending; } };
}

describe('CSV cells (RFC 4180)', () => {
  it('quotes commas, quotes, CR and LF and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('x\r\ny')).toBe('"x\r\ny"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(false)).toBe('false');
  });
  it('uses CRLF line endings', () => {
    expect(csvLine(['a', 'b'])).toBe('a,b\r\n');
  });
  it('prefixes formula-injection starters with a single quote', () => {
    for (const bad of ['=SUM(A1)', '+1', '-1', '@cmd', '\tTAB', '\rCR']) {
      expect(neutralizeFormula(bad)).toBe(`'${bad}`);
    }
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('safe =not leading')).toBe('safe =not leading');
    expect(csvCell("'already")).toBe("'already");
  });
  it('keeps Spanish accents intact', () => {
    expect(csvCell('conexión fallida – año')).toBe('conexión fallida – año');
  });
});

describe('writeCsv / writeJson', () => {
  it('writes BOM + header + rows, BOM optional', async () => {
    const a = sink();
    await writeCsv(a.w, ['c1', 'c2'], [{ x: 'a', y: '1' }], (r) => [r.x, r.y]);
    await new Promise((r) => a.w.once('finish', r));
    expect(a.chunks.join('')).toBe(`${CSV_BOM}c1,c2\r\na,1\r\n`);
    const b = sink();
    await writeCsv(b.w, ['c1'], [], () => [], { bom: false });
    await new Promise((r) => b.w.once('finish', r));
    expect(b.chunks.join('')).toBe('c1\r\n');
  });

  it('streams a large result in bounded chunks instead of one buffer', async () => {
    const N = 50_000;
    function* rows() {
      for (let i = 0; i < N; i++) yield { i, m: `message number ${i} with some padding text to make rows heavier` };
    }
    const s = sink(16 * 1024);
    await writeCsv(s.w, ['i', 'm'], rows(), (r) => [r.i, r.m]);
    await new Promise((r) => s.w.once('finish', r));
    const total = s.chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(3_000_000);
    expect(s.chunks.length).toBeGreaterThan(100); // many writes, not one
    expect(Math.max(...s.chunks.map((c) => c.length))).toBeLessThan(40 * 1024); // each write is small
    expect(s.maxBuffered).toBeLessThan(64 * 1024); // back-pressure respected: the sink never queued the whole file
    expect(s.chunks.join('').split('\r\n')).toHaveLength(N + 2); // header + N rows + trailing empty
  });

  it('JSON envelope: {meta, items} is valid JSON and streamed', async () => {
    const s = sink();
    const meta = { source: 'MOCK', scope: 's', filters: {}, rowCount: 3, truncated: false, generatedAt: 'x', generatedBy: 'u', exportMaxRows: 10 };
    await writeJson(s.w, meta, [{ a: 1 }, { a: 'é' }, { a: null }]);
    await new Promise((r) => s.w.once('finish', r));
    const parsed = JSON.parse(s.chunks.join(''));
    expect(parsed.meta).toEqual(meta);
    expect(parsed.items).toEqual([{ a: 1 }, { a: 'é' }, { a: null }]);
    const empty = sink();
    await writeJson(empty.w, meta, []);
    await new Promise((r) => empty.w.once('finish', r));
    expect(JSON.parse(empty.chunks.join('')).items).toEqual([]);
  });

  it('stops quietly when the destination is destroyed (client disconnect)', async () => {
    const s = sink(16);
    function* rows() {
      for (let i = 0; i < 100_000; i++) yield { i };
    }
    const p = writeCsv(s.w, ['i'], rows(), (r) => ['x'.repeat(100) + r.i]);
    setTimeout(() => s.w.destroy(), 5);
    await expect(p).rejects.toThrow(/aborted/i);
  });
});

describe('file names', () => {
  it('follows urbani-<kind>-<UTC yyyymmdd-HHmmss>.<ext> and sanitises the kind', () => {
    const d = new Date(Date.UTC(2026, 10, 7, 9, 5, 3));
    expect(utcStamp(d)).toBe('20261107-090503');
    expect(exportFileName('logs', 'csv', d)).toBe('urbani-logs-20261107-090503.csv');
    expect(exportFileName('incident-../../evil"id', 'pdf', d)).toBe('urbani-incident-______evil_id-20261107-090503.pdf');
  });
});
