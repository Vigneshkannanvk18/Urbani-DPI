# Branding and dark mode (DPI 2 item 10)

The logo and palette now follow the official Urbani logo supplied by the client (violet gradient #a321ff -> #6a2eff, cyan dot #00d1ff, white "U"). The SVGs in `branding/assets` are a **vector redraw of the supplied image** and the hex values in `branding/brand.css` are **read off that image**, not taken from a brand guideline. Still open with Urbani: the original vector logo files (SVG/PNG, light and dark versions) and the exact palette hex values / dark-mode guidance (client inputs #8/#9/#10). Replacing them follows the checklist below.

## Replace-and-rebuild checklist (< 10 minutes)
1. **Logo** (`packages/frontend/src/branding/assets/`): replace `logo-mark.svg` (square mark, sidebar/login card), `logo-light.svg` (full logo for light backgrounds), `logo-dark.svg` (full logo for dark backgrounds). PNG works too: change the three imports at the top of `branding/brand.ts` to the new file names.
2. **Favicon**: replace `assets/favicon.svg` (or point `<link rel="icon">` in `packages/frontend/index.html` at a `.png`/`.ico`).
3. **Names and legal text**: edit `branding/brand.ts` (`productName`, `shortName`, `tagline`, `documentTitle`, `legal`), set `isPlaceholder: false`, and update `<title>` in `index.html` to match.
4. **Palette**: edit hex values in `branding/brand.css` only (`:root` = light, `[data-theme='dark']` = dark): `--color-primary`, `-hover`, `-soft`, `-border`, `-active`, `-text`, `--color-on-primary`, `--color-focus`, `--color-accent`, `--chart-primary`. Neutrals/semantic colours live in `styles.css` (light) and `theme/theme.css` (dark).
5. Run `node scripts/check-contrast.mjs` (fails with the exact pair if a ratio drops below WCAG AA) and fix any listed token.
6. `npm run build`, then `node scripts/ui-smoke.mjs` for screenshots of every page in both themes (`.tmp/ui-smoke/`).

## Dark mode
Choice `system | light | dark` (default `system`), toggle in the header and on the login page (buttons with `aria-pressed`, keyboard operable). `index.html` applies the saved/system theme before first paint (no flash; the key is `urbani.theme`). The choice is saved in localStorage and, for signed-in users, via `GET/PUT /api/preferences` (own preferences only; `theme`, reserved `widgetLayout`). On login the server value wins when the user has saved one; otherwise the local choice is uploaded. `system` is stored as `theme = null`.
Components only use CSS variables; charts use `var(--chart-*)`. Dark overrides: `theme/theme.css`.

## Contrast check
`scripts/check-contrast.mjs` (also run by the backend test `contrast.test.ts`) checks 37 text/UI token pairs per theme: >= 4.5:1 for text, >= 3:1 for focus ring, chart series and accent graphics. Not covered: decorative borders and input borders, disabled controls, the login artwork, images. Full WCAG validation needs manual testing with assistive technologies.

## Notes
The inline theme script needs `script-src 'unsafe-inline'` (or a hash) if a Content-Security-Policy is ever added to the nginx proxy; none is set today.