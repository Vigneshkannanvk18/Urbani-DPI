# Items 9 and 10 report: service health panel, branding + dark mode, UI smoke

Branch `dpi2` (worktree `.worktrees/dpi2`), commits `cedfb2a` (item 9: backend, shared, infra, docs) and `f20276a` (frontend, branding, dark mode, contrast, UI smoke). Not pushed.

## Item 9: health / uptime
- `packages/backend/src/health/` (ssrf, httpProbe, targets, uptime, runner+scheduler), `services/healthService.ts`, `routes/healthStatusRoutes.ts`; repository methods `recordResult/listResults/latestResult/purgeOlderThan` on SQLite (migration 006) and DynamoDB (`HEALTHRES#<target>`, minute-bucket SK, `HEALTHTARGET` registry).
- Targets: Radar API (DB ping), "Urbani QA telemetry API" (labelled as the observability API; probed only when URBANI_API_BASE_URL/KEY set), QA/Main/Payment = WAITING_FOR_INTEGRATION with the exact note and the HEALTH_TARGETS hint until configured. LIVE only for fresh probed results; stale = UNKNOWN.
- API: `GET /api/health/status|history` (`services:view`), `POST /api/health/check-now` (`settings:update`, 5/min, audit `health.check_now`). Open-alert counts by severity where target maps to a configured service.
- Scheduler: jittered, single-flight, unref'd, aborted on shutdown, off in tests. Retention `HEALTH_RETENTION_DAYS` (30) daily job (logged, not audited). Multi-task probing documented as accepted (idempotent per minute).
- SSRF: env-only URLs, http(s) only, no credentials, metadata/link-local always blocked (fd00:ec2::/32 used), private ranges behind `HEALTH_ALLOW_PRIVATE_TARGETS`, connect-time IP check, every redirect hop checked, read cap, redacted errors.
- UI: Service Health page + Dashboard strip (status + provenance badges, uptime 24h/7d/30d with sample counts, SVG sparkline, 30 s refresh, Check now for permitted roles), nav + route gated.
- IaC (authored, not deployed): `infra/lib/health-monitoring-construct.ts` behind `enableHealthMonitoring` + `healthEndpoints`: Route 53 HTTPS checks, Synthetics heartbeat canary, encrypted 30-day bucket, minimal IAM, alarms (Route 53 alarms only in us-east-1). Container Insights stays item 14.

## Item 10: branding + dark mode
- `packages/frontend/src/branding/` (brand.ts, brand.css, BrandLogo.tsx, assets: logo mark/light/dark SVG, favicon) = PLACEHOLDER current gold/navy look; wired into sidebar, login, document title, favicon, legal footer. `docs/BRANDING.md` has the replace checklist.
- Dark mode: tokens in styles.css/brand.css, `[data-theme='dark']` layer in `theme/theme.css` (neutrals, semantic, severity, charts via `var(--chart-*)`, dialogs, scrollbars, login artwork). `system|light|dark` toggle (header + login), no-flash inline script, localStorage + `GET/PUT /api/preferences` (zod strict, own only, `theme` + reserved `widgetLayout`), sync on login.
- Visible light-theme changes forced by AA: primary button/chat bubble text is now navy (was white on gold, 2.6:1), warning/medium/high text colours are darker, links use `--color-primary-text`.
- Contrast: `scripts/check-contrast.mjs` (74/74 pairs pass) + backend test `contrast.test.ts` (also proves a bad token fails).

## UI smoke (`scripts/ui-smoke.mjs`)
Edge headless over CDP (Node WebSocket, no deps), real backend 4100 (mock, seeded `.tmp/ui-smoke` SQLite) + Vite 5273. UI login, 15 routes (+login) x light/dark, Copilot widget + History panel x2 themes, theme toggle check (DOM, localStorage, API). Result: **37/37 checks passed, 0 failed**; 72 console warnings, all React Router v7 future-flag notices. Screenshots + summary.json in `.tmp/ui-smoke/` (gitignored). Real bug found and fixed: Dashboard health strip read `h.data.targets` (crash, blank dashboard); the first run failed 5 checks, the second run passed all.

## Tests / verification
- `npm run build` ok; `npm test`: **577 passed / 104 skipped** (was 487/99; +90). New: health.test.ts (51: SSRF, probe vs local server incl. timeout/redirect-to-metadata, targets, uptime, single-flight/fake-timer scheduler), routes/health.test.ts (29: RBAC, audit, 429, preferences, retention), contrast.test.ts (5), 5 contract cases x 2 drivers, migrations list updated.
- DynamoDB Local (Docker, container stopped after): health contract cases pass.
- `npx tsc -b --noEmit` (frontend) clean; infra `tsc --noEmit` and `npm run check` pass (new assertions for flag off/on).
- Ports 4100/4101/5273/9333 verified free; no smoke node/Edge processes left (the user's own Edge windows were untouched).

## Visual nits found, not fixed
- Sidebar background stops at 900 px in full-page screenshots (sticky 100vh; artefact of capture).
- Dashboard observability chart shows no series (mock data window empty in the fresh DB).
- Radar API sparkline is flat/0 ms (SQLite ping); uptime shows "n/a" until 10 samples.
- Login artwork (tablet mock) only lightly re-coloured for dark.
- Wide WAITING badge text wraps in health strip cards on narrow widths.

## Not exercised
Real QA/Main/Payment endpoints, the real Urbani API probe, HTTPS/TLS probe paths, 2+ task behaviour, Route 53/Synthetics (never synthesized with a resolved region or deployed), keyboard-only/screen-reader testing of the toggle, mobile layouts, Firefox/Safari, WCAG beyond token contrast, DynamoDB retention at 30d volume (43k items/target read per status call; add rollups if it matters).

## Client input needed
1. Health endpoint URLs for QA, Main, Payment (+ expected status/auth) and whether they are reachable from the ECS task network (else internal ALB + `HEALTH_ALLOW_PRIVATE_TARGETS=true`).
2. Official logo (SVG/PNG, light and dark), palette hex codes, dark-mode guidance (client inputs #8-#10).
3. Confirm uptime definition (strict UP only) and retention (30 d placeholder).