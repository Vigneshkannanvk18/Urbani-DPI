import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Theme contrast (DPI 2 item 10): runs scripts/check-contrast.mjs against the real frontend token CSS and fails when
 * a main text/background pair drops below WCAG AA (4.5:1 text, 3:1 UI components) in the light or the dark theme.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-contrast.mjs');
const FRONTEND_SRC = path.join(ROOT, 'packages', 'frontend', 'src');

interface Row { theme: string; fg: string; bg: string; ratio: number | null; min: number; pass: boolean }
const runJson = (): { rows: Row[]; themes: { light: Record<string, string>; dark: Record<string, string> } } =>
  JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' }));
const ratio = (fg: string, bg: string): number => Number(execFileSync(process.execPath, [SCRIPT, '--ratio', fg, bg], { encoding: 'utf8' }));
describe('theme contrast (WCAG AA)', () => {
  it('the contrast script exits 0 for the shipped tokens', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(out).toMatch(/pairs pass WCAG AA/);
  });

  it('checks both themes and every pair meets its minimum ratio', () => {
    const { rows } = runJson();
    expect(rows.some((r) => r.theme === 'light')).toBe(true);
    expect(rows.some((r) => r.theme === 'dark')).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(60);
    const failing = rows.filter((r) => !r.pass).map((r) => `${r.theme}: ${r.fg} on ${r.bg} = ${r.ratio?.toFixed(2)} (< ${r.min})`);
    expect(failing).toEqual([]);
    // body text pairs are held to 4.5:1
    expect(rows.filter((r) => r.fg === '--color-text-primary').every((r) => r.min === 4.5)).toBe(true);
  });

  it('computes known contrast ratios correctly', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(ratio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(ratio('#777777', '#ffffff')).toBeLessThan(4.6);
  });

  it('fails (exit 1) when a token is changed to a low-contrast value', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrast-'));
    try {
      fs.cpSync(FRONTEND_SRC, tmp, { recursive: true, filter: (s) => !s.includes('node_modules') && /\.(css)$|branding|theme|^[^.]*$/.test(path.basename(s)) || fs.statSync(s).isDirectory() });
      const styles = path.join(tmp, 'styles.css');
      fs.writeFileSync(styles, fs.readFileSync(styles, 'utf8').replace('--color-text-secondary: #566073;', '--color-text-secondary: #c0c4cc;'));
      const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, CONTRAST_CSS_DIR: tmp } });
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/FAIL light.*--color-text-secondary/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dark layer overrides every colour token of the light theme (except the documented shared ones)', () => {
    const { light, dark } = runJson().themes;
    const sameInBothThemes = new Set([
      '--color-danger-solid', // solid red pill with white text works in both themes
      '--color-on-danger',
      '--chart-info', // var(--color-accent), which is overridden
    ]);
    const colourTokens = Object.entries(light).filter(([k, v]) => /^(#|rgba?\()/.test(v) && /^--(color|sev|chart|overlay|skeleton|shadow)/.test(k));
    expect(colourTokens.length).toBeGreaterThan(40);
    const missing = colourTokens.filter(([k, v]) => !sameInBothThemes.has(k) && dark[k] === v).map(([k]) => k);
    expect(missing).toEqual([]);
  });
});
