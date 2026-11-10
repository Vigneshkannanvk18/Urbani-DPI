# Item 4 report: advanced log filters and search

Commit on `dpi2`: `21bb34e` (on top of `1c1e529`; not pushed). Status: DONE (integration pending).

## What was built

- Query model (`lib/logQuery.ts`): `levels` (multi), `services` (multi, "Server" in the UI), `from`/`to` (ISO), `search`/`text`, `regex=true`, `sort=newest|oldest`, `page`/`pageSize`. Legacy `service`, `level`, `search`, `page`, `pageSize`, `environment` still work. Cursor paging was not added; page/pageSize is used.
- Safe regex (`lib/safeRegex.ts`): max length (`LOGS_REGEX_MAX_LENGTH`, 200), must compile, no back-references, nested/alternated repetition rejected (`(a+)+`, `(a|aa)*`), messages truncated to 1000 chars, 250 ms `node:vm` timeout. Bad or unsafe regex returns 400 in about 5 ms.
- Adapters: `CloudWatchLogQuery` extended; shared `integrations/logFilter.ts` used by Mock and `HttpUrbaniLogsAdapter` (levels, services, date range, text, regex, sort, truncation flag). New `integrations/aws/CloudWatchLogsInsightsAdapter.ts` (StartQuery/GetQueryResults, polling with timeout, escaped query building), selected only with `LOGS_SOURCE=insights`.
- Response: Sourced envelope unchanged plus `meta` = `applied`, `sort`, `total`, `truncated`, `windowCap`, `scope`. The route baseline JSON gained the new `meta.*` keys (additive).
- Audit: `logs.search` now carries `levels`, `services`, `search`, `regex`, `from`, `to`, `sort` (when oldest), plus the legacy keys.
- Config / env: `LOGS_SOURCE`, `LOGS_INSIGHTS_LOG_GROUPS`, `LOGS_INSIGHTS_TIMEOUT_MS`, `LOGS_INSIGHTS_MAX_RESULTS`, `LOGS_REGEX_MAX_LENGTH` in config and `.env.example`.
- Infra (authored, not deployed): `UrbaniDashboardTaskRole` gets `logs:StartQuery` + `logs:DescribeLogGroups` on the configured log groups and `logs:GetQueryResults` on `*`, only when `logsInsightsLogGroups` (context / `URBANI_LOGS_INSIGHTS_LOG_GROUPS`) is set.
- UI (`pages/Logs.tsx`): severity checkboxes, Server select, from/to datetime-local, text box (400 ms debounce) with Regex toggle and inline validation, Apply/Reset, active-filter chips, sort toggle, pagination, result count, truncation notice, scope note, provenance badge, loading/empty/error states, and the existing "Live logs temporarily unavailable" state. Filters are synced to the URL query string.
- Docs: `docs/LOG_SEARCH.md`.

## Files

New: `lib/safeRegex.ts`, `lib/logQuery.ts`, `integrations/logFilter.ts`, `integrations/aws/CloudWatchLogsInsightsAdapter.ts`, docs/LOG_SEARCH.md, and tests `lib/safeRegex.test.ts`, `integrations/logFilter.test.ts`, `integrations/aws/CloudWatchLogsInsightsAdapter.test.ts`, `routes/logs.test.ts`.
Changed: `config/index.ts`, `integrations/{index,types}.ts`, `integrations/mock/MockCloudWatchAdapter.ts`, `integrations/live/HttpUrbaniLogsAdapter.ts`, `routes/apiRoutes.ts`, `routes/routes.baseline.json`, `services/telemetryService.ts`, `shared/common.ts`, frontend `api/endpoints.ts` and `pages/Logs.tsx`, `infra/config/index.ts`, `infra/lib/security-construct.ts`, `.env.example`, `packages/backend/package.json` (+ `@aws-sdk/client-cloudwatch-logs` 3.1162.0, exact), lockfile.

## Tests and verification (each run once)

- `npm run build` at the root: pass.
- `npm test` at the root: 347 passed / 83 skipped (was 308 / 83; +39 new). New: safeRegex 7, filters (mock + live with mocked fetch) 10, Insights adapter with mocked SDK 14, route/validation/audit 8.
- `npx tsc -b --noEmit` in `packages/frontend`: clean.
- `cd infra && npx tsc --noEmit`: clean.
- Smoke on port 4100 (worktree-local SQLite, mock mode): `levels=ERROR,WARN&services=main&search=timeout|exhausted&regex=true&pageSize=3` returned 3 of 5 with applied-filters meta, source MOCK; `(a+)+$`, `(` and `from=bad` returned 400 in 3 to 7 ms; the `logs.search` audit event contained the filter parameters. Server stopped.
- Not covered: the frontend UI was typechecked and built but not driven in a browser. No role lacks `logs:view`, so there is no 403 route test (401 without token is tested).

## Honest statement

The Logs Insights adapter was NOT exercised against real AWS. It is unit-tested with a mocked client only. No AWS call or CLI was made. In Insights mode the level filter is applied after retrieval (levels are inferred from message text), so a level filter only sees the capped result window.

## To go LIVE / client input needed

- Log group names or ARNs for QA, Main, Payment (and account/region), plus read access for the dashboard task role; or an extension of the Urbani `/logs` API (all lines, date range, text filter).
- Env vars: `LOGS_SOURCE=insights`, `LOGS_INSIGHTS_LOG_GROUPS=main=/aws/...,payments=/aws/...`, optionally `LOGS_INSIGHTS_TIMEOUT_MS`, `LOGS_INSIGHTS_MAX_RESULTS`.
- IAM: apply the CDK change by setting `logsInsightsLogGroups` (context or `URBANI_LOGS_INSIGHTS_LOG_GROUPS`) and deploying (item 14, with approval).
- Until then Main/Payment without a readable source show `WAITING_FOR_INTEGRATION` or `MOCK`, never `LIVE`.
