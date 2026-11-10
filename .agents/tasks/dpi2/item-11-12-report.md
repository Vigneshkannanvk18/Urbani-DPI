# Items 11 + 12: Export, and Dashboard personalization (DPI 2, LEAN)

Commits on `dpi2`: `90f1a77` (item 11), `23385fb` (item 12). Not pushed. Docs: `docs/EXPORT.md`, `docs/DASHBOARD_WIDGETS.md`; `docs/RBAC.md` and `.env.example` updated.

## Item 11: Export
- `GET /api/logs/export?format=csv|json|pdf` (+`bom`): same filter parsing, safe-regex rules and adapters as `/api/logs` (shared `parseLogSearch`, new `telemetryService.exportLogs`), page/pageSize ignored, sort honoured, capped at `EXPORT_MAX_ROWS` (10000); PDF capped at `EXPORT_PDF_MAX_ROWS` (2000) with a visible notice.
- `GET /api/alerts/export?format=csv|json` with the alert list filters and the requested columns (`confidenceDerived` true for LIVE alerts). `GET /api/alerts/:id/report?format=pdf` (404 for unknown id).
- Permission `logs:export` for all three (roles unchanged: all four draft roles hold it). Order: 401, 403, per-user rate limit (429, `EXPORT_RATE_LIMIT_PER_MIN`), 400, data, stream.
- Streaming CSV/JSON with back-pressure and clean abort on disconnect; `EXPORT_TIMEOUT_MS` deadline; headers `Content-Disposition` (sanitised name `urbani-<kind>-<UTC stamp>.<ext>`), `Cache-Control: no-store`, `X-Export-Source/Rows/Truncated`.
- CSV: RFC 4180, CRLF, BOM default, formula-injection prefix. JSON envelope with meta (source, scope, filters, rowCount, truncated, generatedAt, generatedBy, exportMaxRows). PDF: pdfkit 0.15.1 pinned in `packages/backend`, Helvetica only, bufferPages + final footer pass, 8 pt bottom margin, measured rows.
- Audit actions `logs.export`, `alerts.export`, `incident.report` (SENSITIVE_QUERY): format, filters, rowCount, truncated; never content.
- UI: Logs and Alerts "Export" dropdown (gated by `logs:export`, note with scope, busy state, 400/401/403/429 messages in an aria-live region), "Download incident report (PDF)" on alert detail.
- Hygiene: `packages/frontend/tsconfig.tsbuildinfo` untracked, `*.tsbuildinfo` ignored.

## Item 12: Dashboard personalization
- `packages/shared/src/dashboardLayout.ts`: 7-widget registry (kpi, service-health, system-health, ai-cost, observability, recent-alerts, recent-analyses) with permission and size, `normalizeLayout`, `defaultLayout`. Exposed as subpath `@urbani/shared/dashboardLayout` (the shared CJS build cannot give Vite named exports; same pattern as `rbac`).
- `PUT /api/preferences` `widgetLayout`: zod strict, version 1, max 30 entries, known ids; `null` resets; own-only.
- UI: Customize toggle, drag handle (native HTML5 DnD, no new dependency), up/down buttons, Hide + "Hidden widgets" tray, Save/Cancel/Reset to default, unsaved indicator, optimistic save with rollback, per-user localStorage cache with server winning, live-region announcements ("Service health moved to position 3 of 7"), 1-column layout under 900 px.

## Tests
Default suite: **619 passed / 104 skipped** (was 577 / 104; +42 new). New: `lib/export/formats.test.ts` (9: CSV quoting/CRLF/BOM/injection, 50k-row streaming with back-pressure and bounded chunks, JSON envelope, abort, file names), `lib/export/pdf.test.ts` (5: %PDF header, page count equals `/Type /Page` objects for 0/1/40/400 rows, accents, truncation notice, 2000-char message), `routes/export.test.ts` (21: filters parity with `/api/logs`, caps + headers, 400/401/403 per role, rate limit 429 per user, audit content, incident 200/404, preferences own-only), `lib/dashboardLayout.test.ts` (7), plus the updated widgetLayout case in `health.test.ts`.
Checks: `npm run build` ok; `npm test` as above; `npx tsc -b --noEmit` in `packages/frontend` clean. infra untouched. No repository methods added, so no DynamoDB contract run.

## UI smoke (`node scripts/ui-smoke.mjs`, headless Edge, ports 4100/5273/9333)
**43/43 checks passed**, 0 failed, 78 console warnings (React Router v7 future-flag warnings, 2 per page, pre-existing). New checks: `logs-export-menu`, `logs-export` (real UI CSV click shows "urbani-logs-...csv downloaded"; CSV header row, JSON `{"meta":`, PDF `%PDF-` and `%%EOF`, status/type/size), `alerts-export-report` (alerts CSV/JSON, incident PDF, unknown id 404), `dashboard-customize` (light + dark), `dashboard-customize-flow` (customize, move with button, live-region text, hide, tray, unsaved indicator, Save, server layout, reload persists, narrow 420 px viewport, Reset restores default order and clears the server value). Screenshots: `.tmp/ui-smoke/` (40 PNG, incl. `dashboard-customize.narrow.png`, `logs-export-menu.dark.png`).

Samples: Logs CSV header `timestamp,level,service,environment,message,id`; alerts CSV header `alertId,timestamp,service,environment,severity,anomalyType,status,summary,probableCause,confidence,confidenceDerived,recommendedActions,evidenceCount`. A 400-row logs PDF has 9 pages and 9 page objects.

Ports 4100/4101/5273/9333 confirmed free after the run (only stale PID-0 TCP entries from the OS, nothing answering). One earlier smoke run was left running by a timed-out shell call; I killed that process tree (its own node + children only).

## Visual nits (not fixed)
- In customize mode each widget shows its title twice (toolbar and card title).
- Half-width widgets leave an empty cell when a lone half widget ends a row.
- The Logs export note is long and right-aligned under the button; it states "10,000" as fixed text although `EXPORT_MAX_ROWS` is configurable.
- Customize frames are dimmed and non-interactive by design.

## Not exercised
- Logs Insights as export source (mocked adapters only); the default source is a capped 100-line window, so exports are usually flagged truncated.
- Real browser file-save dialog (download verified by the UI status message and in-page fetches, not a saved file); touch drag-and-drop (buttons are the touch path); real screen readers (live-region text asserted only).
- Rate limit is in-memory per instance (not shared across ECS tasks). Memory profile of a full 10k-row PDF/CSV not measured beyond the 50k-row synthetic streaming test.
- Reader/Auditor browser view (RBAC covered in supertest only). Widgets fetch their data even when hidden or not permitted (no lazy loading).
- S3 staging: not built (documented follow-up).

## Client input needed
1. Export size limits (10,000 rows CSV/JSON, 2,000 PDF rows) and whether very large exports should go through S3 with a pre-signed link.
2. Retention of exported files: the platform stores none; is an export register needed beyond the audit events?
3. May Reader/Auditor (and QA Operator) export? Currently yes (draft matrix; one permission covers all exports).
4. Which Dashboard widgets are in scope for personalization (all 7 now), and whether layouts should be shareable or have an admin-set default.
