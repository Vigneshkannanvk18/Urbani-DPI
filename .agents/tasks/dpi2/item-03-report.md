# DPI 2 item 3 report: audit log (config changes + sensitive queries)

- **Status:** DONE (integration pending). LEAN mode: no design/review loop.
- **Branch / commit:** `dpi2` in `.worktrees\dpi2`, commit `1c1e529` (on top of `1b3b3d3`). Not pushed.

## What was built
- **One catalog:** `AUDIT_ACTION_CATALOG` (+ `AUDIT_CATEGORIES`, `auditActionsForCategory`) in `packages/shared/src/domain.ts` classifies every action as CONFIG or SENSITIVE_QUERY. New actions: `chat.query`, `logs.search`, `ai.analyze`, `audit.view`, `audit.purge`. Auth and access events (login, logout, login_failed, access.denied) are grouped as SENSITIVE_QUERY.
- **Coverage gaps filled:** AI analyze, log search (filter parameters only), audit view/search, chat (was recorded as `ALERT_VIEWED`; now `chat.query` with service + 80 char preview, never the answer; FAILURE event when the assistant is unavailable). Everything else already existed (login, logout, user.*, settings, acknowledge, access.denied). Each request writes exactly one event per action (tested).
- **Event fields:** actor email, action, target, result, timestamp as before; user id, role, IP and request (correlation) id are stored in `metadata.ctx` via an AsyncLocalStorage request context (`lib/auditMetadata.ts`), so no schema change on either driver.
- **Redaction:** central `redact()` inside both drivers' `record` (keys matching password, token, authorization, api key, secret, cookie, any depth). Unit tested.
- **API (`audit:view`):** `GET /api/audit` with from, to, actor, userId, action, result, category, text, limit, cursor (newest first). Without the new params the DPI 1 page/pageSize response is unchanged. `GET /api/audit/actions` for the dropdown. No update/delete route (tested: 404).
- **Repository:** `AuditRangeQuery` gained `actions`, `result`, `text`, `metadataContains`; new `purgeOlderThan(cutoff)` (the only delete). SQLite uses SQL filters; DynamoDB keeps the ADR 0001 access patterns (AUDIT partition / GSI1 by actor) and applies the non-key filters while paging the same key range, so cursors still work. Purge queries `SK < cutoff` and batch-deletes (new `queryPage` helper in `ops.ts`). No schema change.
- **Retention:** `AUDIT_RETENTION_DAYS` (default 365, 0 = forever), `AUDIT_RETENTION_JOB` (default true). Runs at startup and every 24h from `server.ts`, deletes old events, writes ONE `audit.purge` summary event. Added to `.env.example`.
- **UI:** `pages/Audit.tsx` rebuilt: date range, user email, action dropdown (from `/audit/actions`), result, category, free text, table (timestamp, user, role, action, target, result badge, expandable redacted metadata), Previous/Next cursor paging, empty and error states. Route and nav were already gated by `audit:view`. Source badge convention kept (MOCK: application-level events).
- **Docs:** `docs/AUDIT.md`.

## Tests
- New `routes/audit.test.ts` (19 tests): catalog, per-action single event with fields, redaction, 403/200/401 access, append-only, reader cannot mutate, filters, date range, cursor paging, legacy shape, retention (only old events removed, one summary event, 0 = no-op).
- New `lib/auditMetadata.test.ts` (3 tests): redaction and preview.
- New contract cases C-AU-08 (filters + cursor) and C-AU-09 (purge) for both drivers.
- `routes.baseline.json` steps 19 and 26 got additive `metadata.ctx.*`, `service`, `questionPreview`, `environment` keys (additive, no key removed).
- Totals: **308 passed, 83 skipped** (was 280 / 81), 25 files passed.

## Verification (run once on the final tree)
- `npm run build` (root): exit 0.
- `npm test` (root): exit 0, 308 passed / 83 skipped.
- `npx tsc -b --noEmit` in packages/frontend: exit 0.
- **DynamoDB Local was exercised** for the audit contract cases only (`amazon/dynamodb-local:2.5.2`, `-t C-AU`): 18 passed (9 cases x 2 drivers). The full DynamoDB suite was not re-run. Container stopped.
- Smoke on port 4100 with a worktree-local SQLite file: seeded admin logged in, acknowledged an alert, PUT settings with a `password` field, searched logs, created a QA_OPERATOR. `GET /api/audit` listed LOGIN, ALERT_ACKNOWLEDGED, CONFIG_CHANGED, logs.search, user.create and the startup audit.purge; ack metadata carried ip, requestId, userId, email, role; no password string anywhere in the response; QA_OPERATOR got 403. Server stopped, port free, temp DB removed. UI was not exercised in a browser.

## Notes
- `ALERT_VIEWED` (alert detail) stays audited and is classed SENSITIVE_QUERY.
- DynamoDB filtered queries scan the key range newest first until the page fills; cost is bounded by the retention window. Revisit if the log grows very large.
- Retention is on the app side (query + batch delete), not DynamoDB TTL, to leave the item 1 schema untouched.
- The tracked `packages/frontend/tsconfig.tsbuildinfo` changed with the build and was committed with it.

## Client input needed
1. **Which actions the client considers sensitive** (current draft list is in `docs/AUDIT.md`; e.g. is viewing an alert, login or chat sensitive?). Change only `AUDIT_ACTION_CATALOG`.
2. **Retention period** for the audit log (placeholder 365 days; `AUDIT_RETENTION_DAYS`, 0 = forever) and whether it must be immutable/exported (e.g. to S3 or CloudTrail) before purge.
3. Whether Infra Admin should see the audit log (draft matrix says yes; carried over from item 2).
