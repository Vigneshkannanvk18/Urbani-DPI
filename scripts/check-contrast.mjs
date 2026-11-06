#!/usr/bin/env node
/**
 * WCAG 2.x AA contrast check for the theme tokens (DPI 2 item 10). Plain node, no dependencies.
 *
 *   node scripts/check-contrast.mjs            # exit 0 = all pairs pass, 1 = at least one violation
 *   node scripts/check-contrast.mjs --json     # same data as JSON (used by the backend test)
 *   node scripts/check-contrast.mjs --ratio #000000 #ffffff
 *
 * Reads the CSS custom properties declared in `:root { }` (light) and `[data-theme='dark'] { }` (dark) blocks of
 * branding/brand.css, styles.css and theme/theme.css. Dark = light tokens overlaid with the dark block.
 * Requirements: >= 4.5:1 for body text pairs, >= 3:1 for large text and UI components / graphics.
 * Not covered (documented in docs/BRANDING.md): decorative borders, disabled controls, images, login artwork.
 * Set CONTRAST_CSS_DIR to point at another frontend/src folder (used by the unit test to prove failures are caught).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.CONTRAST_CSS_DIR ?? path.resolve(here, '..', 'packages', 'frontend', 'src');
const FILES = ['branding/brand.css', 'styles.css', 'theme/theme.css'];

export function parseTokens(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const light = {};
  const dark = {};
  const re = /(:root|\[data-theme=['"]dark['"]\])\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const target = m[1] === ':root' ? light : dark;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim();
      if (name.startsWith('--')) target[name] = decl.slice(i + 1).trim();
    }
  }
  return { light, dark };
}

export function loadThemes(dir = SRC) {
  const light = {};
  const dark = {};
  for (const f of FILES) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const t = parseTokens(fs.readFileSync(p, 'utf8'));
    Object.assign(light, t.light);
    Object.assign(dark, t.dark);
  }
  return { light, dark: { ...light, ...dark } };
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(fgHex, bgHex) {
  const a = hexToRgb(fgHex);
  const b = hexToRgb(bgHex);
  if (!a || !b) return null;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function resolve(tokens, name, depth = 0) {
  const v = tokens[name];
  if (v === undefined) return null;
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref && depth < 5) return resolve(tokens, ref[1], depth + 1);
  return v;
}

const TEXT = 4.5;
const UI = 3;
const t = (fg, bg, min = TEXT, note = '') => ({ fg, bg, min, note });

/** The pairs that matter: body text on every surface, status text on its soft tint, controls and chart series. */
export const PAIRS = [
  t('--color-text-primary', '--color-background'),
  t('--color-text-primary', '--color-surface'),
  t('--color-text-primary', '--color-surface-2'),
  t('--color-text-primary', '--color-primary-soft'),
  t('--color-text-secondary', '--color-background'),
  t('--color-text-secondary', '--color-surface'),
  t('--color-text-secondary', '--color-surface-2'),
  t('--color-text-muted', '--color-background'),
  t('--color-text-muted', '--color-surface'),
  t('--color-text-muted', '--color-surface-2'),
  t('--color-primary-text', '--color-background', TEXT, 'links / accent text'),
  t('--color-primary-text', '--color-surface', TEXT, 'links / accent text'),
  t('--color-primary-text', '--color-surface-2', TEXT, 'links / accent text'),
  t('--color-primary-active', '--color-primary-soft', TEXT, 'active nav item'),
  t('--color-on-primary', '--color-primary', TEXT, 'primary button'),
  t('--color-on-primary', '--color-primary-hover', TEXT, 'primary button hover'),
  t('--color-on-danger', '--color-danger-solid', TEXT, 'alert count pill'),
  t('--color-success', '--color-success-soft'),
  t('--color-success', '--color-surface'),
  t('--color-warning', '--color-warning-soft'),
  t('--color-warning', '--color-surface'),
  t('--color-danger', '--color-danger-soft'),
  t('--color-danger', '--color-surface'),
  t('--color-info', '--color-info-soft'),
  t('--color-info', '--color-surface'),
  t('--sev-low', '--sev-low-soft'),
  t('--sev-medium', '--sev-medium-soft'),
  t('--sev-high', '--sev-high-soft'),
  t('--sev-critical', '--sev-critical-soft'),
  t('--color-focus', '--color-surface', UI, 'focus ring'),
  t('--color-focus', '--color-background', UI, 'focus ring'),
  t('--color-primary-active', '--color-surface', UI, 'active icon / accent graphic'),
  t('--chart-primary', '--color-surface', UI, 'chart series'),
  t('--chart-info', '--color-surface', UI, 'chart series'),
  t('--chart-success', '--color-surface', UI, 'chart series'),
  t('--chart-danger', '--color-surface', UI, 'chart series'),
  t('--chart-axis', '--color-surface', TEXT, 'chart axis labels'),
];

export function check(dir = SRC) {
  const themes = loadThemes(dir);
  const rows = [];
  for (const theme of ['light', 'dark']) {
    for (const p of PAIRS) {
      const fg = resolve(themes[theme], p.fg);
      const bg = resolve(themes[theme], p.bg);
      const ratio = fg && bg ? contrast(fg, bg) : null;
      rows.push({
        theme, fg: p.fg, bg: p.bg, fgValue: fg, bgValue: bg, min: p.min, note: p.note,
        ratio, pass: ratio !== null && ratio >= p.min,
        problem: ratio === null ? `missing or non-hex token (${fg === null ? p.fg : p.bg})` : null,
      });
    }
  }
  return rows;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === '--json') {
  // Machine-readable output for the backend test: pairs plus the merged token maps.
  console.log(JSON.stringify({ rows: check(), themes: loadThemes() }));
} else if (isMain && process.argv[2] === '--ratio') {
  console.log(String(contrast(process.argv[3], process.argv[4])));
} else if (isMain) {
  const rows = check();
  const bad = rows.filter((r) => !r.pass);
  for (const r of rows) {
    const mark = r.pass ? 'ok  ' : 'FAIL';
    const ratio = r.ratio === null ? ' n/a' : r.ratio.toFixed(2).padStart(5);
    console.log(`${mark} ${r.theme.padEnd(5)} ${ratio}:1 (min ${r.min})  ${r.fg} on ${r.bg}  ${r.fgValue ?? '?'} / ${r.bgValue ?? '?'}  ${r.note}`);
  }
  console.log(`\n${rows.length - bad.length}/${rows.length} pairs pass WCAG AA`);
  if (bad.length) {
    console.error(`${bad.length} contrast violation(s)`);
    process.exit(1);
  }
}
