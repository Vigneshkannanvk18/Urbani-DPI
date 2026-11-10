# Item 6 report: Automatic alerts by e-mail (SNS), Slack and Teams

Status: DONE (integration pending). Branch `dpi2`, commits `064831c` (backend, shared, infra, docs) and `906d3ca` (frontend). Not pushed. LEAN mode: no design or review loop.

## What was built

- **Engine** (in the backend process): `packages/backend/src/notifications/`. ALERT_OPENED only: an OPEN alert id is notified once per channel. Acknowledged/resolved alerts and MOCK alerts are never notified (MOCK only with `NOTIFICATIONS_ALLOW_MOCK=true`). It reads alerts, never writes or invents them. ALERT_ESCALATED was optional and is NOT implemented.
- **Rules + settings** through the repository layer: interfaces, SQLite migration `004_dpi2_notifications.sql`, DynamoDB driver, contract cases. Rule fields as requested. DRAFT default rule "Critical and High to all configured channels (DRAFT default)" is seeded ENABLED (HIGH+, all 3 channels); unconfigured channels only log `SKIPPED_NOT_CONFIGURED`. Settings: `dedupWindowMinutes` (30), `maxPerHourPerChannel` (30).
- **Dedup / claim**: atomic conditional write per `(dedupKey, channel)` before sending (SQLite `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, DynamoDB conditional `PutItem`). Keys: `alert:<id>:OPENED` (permanent, silent when lost so polls do not spam the log) and `type:<service>:<env>:<anomalyType>` (window, logs `SKIPPED_DEDUP`). Note: the per-alert claim is permanent rather than windowed, so an open alert never re-notifies when the window expires; the window applies to service + environment + anomaly type.
- **Rate cap**: hourly count per channel, `SKIPPED_RATE_LIMIT` entry.
- **Delivery log**: all requested fields plus a one-line `summary`; retention purge daily (`NOTIFICATIONS_LOG_RETENTION_DAYS`, 90) in a sibling job `startNotificationRetentionJob` (also purges old claims).
- **Adapters** behind `NotificationChannel`: SNS (`@aws-sdk/client-sns` pinned 3.1162.0), Slack (text + blocks), Teams (Adaptive Card default, `messagecard` option). 10 s timeout, 3 attempts with exponential backoff on 5xx/network/timeout, no retry on 4xx, redirects not followed. SSRF guard (https, host allow-list incl. `NOTIFICATIONS_WEBHOOK_HOST_ALLOWLIST`, no credentials/ports); a rejected URL gives `NOT_CONFIGURED` with a reason, never a crash. URLs are stripped from every error string; API shows masked host only.
- **Poller**: `NOTIFICATIONS_ENABLED` (default false), `ALERT_POLL_MINUTES` (5). Started in `server.ts`, runs the alert sync then the engine, single-flight, unref'd, stopped on shutdown, skipped in tests. Also triggered after a live sync stored alerts (single-flight, 15 s minimum spacing). Watermark ("engine first ran at") + `NOTIFICATIONS_MAX_ALERT_AGE_MINUTES` (60) prevent a first-run blast. In mock mode the poller runs only for demos (`NOTIFICATIONS_ALLOW_MOCK=true`).
- **API** (`/api/notifications/...`): `channels`, `rules` (GET/POST/PUT/DELETE), `settings` (GET/PUT), `log` (filters + pagination), `test`. Read = `alerts:view`, mutate/test = `alerts:rules` (Super Admin + Infra Admin per the DRAFT matrix; QA operator and reader are read-only). zod validation, test-send limited to 5/min/user, five new audit actions registered.
- **UI**: Notifications page + nav item (permission `alerts:view`): channel cards with CONFIGURED / NOT_CONFIGURED / DRY_RUN badges and a Test button (only with `alerts:rules`), rules table with create/edit `<dialog>`, enable toggle and delete, dedup/rate form, delivery log with filters and paging, honest empty states.
- **IaC** (authored, not deployed): `infra/lib/notifications-construct.ts`, opt-in with `-c enableNotifications=true`: KMS-encrypted SNS topic, optional e-mail subscriptions (`alertEmails`), `sns:Publish` on that topic and KMS-via-SNS for the task role, secret ARN outputs for existing Secrets Manager secrets (names via context; no values in code). Default stack unchanged. Deploy scripts untouched.
- **Docs**: `docs/NOTIFICATIONS.md`; `.env.example` updated.

## Deliberate deviation from the proposal (client to confirm at kickoff)

The scope doc proposes DynamoDB Streams -> Lambda notifier -> SNS + webhooks. We implemented the notifier **in-process in the backend** because it works on both drivers (SQLite in DPI 1 / dev has no streams), needs no extra AWS parts, and live alerts come from polling the Urbani QA API anyway. Safety with 2+ ECS tasks comes from the atomic claim. The Streams + Lambda variant is described in the docs as an alternative; the engine and adapters are reusable there.

## Tests (default suite, no Docker/AWS/network)

Total: **468 passed / 95 skipped** (before: 395 / 86). New: +73 passed, +9 skipped (the DynamoDB-gated contract cases).

- `notifications/guard.test.ts` (6): allow-list, SSRF rejections, masking, redaction.
- `notifications/channels.test.ts` (18): Slack, Teams (both formats), SNS payloads, retries on 5xx, no retry on 4xx, timeout, URL redaction, not-configured.
- `notifications/engine.test.ts` (19): rule matching, default rule, notified once, ack/MOCK/below-threshold skipped, first-run no-blast, dedup window, window 0, rate cap, two engines racing = one send, FAILED, dry-run, not-configured, test-send.
- `notifications/poller.test.ts` (3): start/stop, no overlap, survives failures (fake timers).
- `routes/notifications.test.ts` (18): RBAC matrix (reader/QA 403, admin OK), validation 400s, audit, test-send (SENT / SNS / DRY_RUN / not configured / FAILED), rate limit 429, masked statuses, no URLs in any response.
- Contract `C-NT-01..09` (SQLite default + DynamoDB-gated): rules, DUPLICATE, settings/watermark, claim window, concurrent claims, log filters/pagination, delivery count, purge, alerts `dataSource` filter.

## Verification (run once)

- `npm run build` at the worktree root: OK.
- `npm test` at the worktree root: 468 passed / 95 skipped.
- `npx tsc -b --noEmit` in `packages/frontend`: clean.
- `cd infra && npx tsc --noEmit`: clean; `npm run check` (offline template assertions, extended for the SNS topic): passed.
- DynamoDB Local (Docker was running; throwaway container on port 8100, stopped afterwards): contract suite 168/168 including `C-NT-01..09`.
- Smoke on port 4100 (worktree-local SQLite in `.tmp/`, mock mode, `NOTIFICATIONS_ENABLED/DRY_RUN/ALLOW_MOCK=true`, a fake Slack URL set): created a rule via API (Super Admin); the poller produced `DRY_RUN` entries for EMAIL, SLACK and TEAMS for the seeded MOCK alerts; `POST /notifications/test` returned `DRY_RUN`; `GET /notifications/log` listed them; the fake webhook URL appeared nowhere in the responses; a Reader/Auditor got 403 on rule creation. Server stopped (nothing listening on 4100). Note: while cleaning `.tmp/smoke*` I also removed an older worktree-local `.tmp/smoke` folder from a previous item (git-ignored scratch data).

## Honest limits

- **No real SNS publish, Slack post or Teams post was exercised.** Adapters were tested with a mocked `fetch` and a mocked SNS client only. Payload shapes follow the providers' documented formats but are unproven against the live services (Teams Workflows card in particular).
- **The UI was not exercised in a browser.** It compiles and builds; the API behind it was smoke tested.
- The hourly rate cap and the test-send limiter are not strict across several tasks (the claim is; the count and the in-memory limiter are per read/task).
- Delivery-log listing on DynamoDB filters in memory over the retention window (bounded by 90 days by default).
- Only the newest 200 OPEN alerts per source are evaluated each run.
- `packages/frontend/tsconfig.tsbuildinfo` (tracked build artefact) shows as modified and was deliberately not committed.

## To go LIVE / client input needed

1. **Alert e-mail addresses** and who confirms the SNS subscription e-mails (unconfirmed subscribers receive nothing).
2. **Slack and/or Teams webhook URLs** (secrets; Secrets Manager -> ECS secrets, item 14).
3. **Rules**: minimum severity, services, anomaly types, channels per audience, dedup window (default 30 min) and hourly cap (default 30). The seeded default rule is a DRAFT (input #7).
4. Public dashboard URL for deep links (`DASHBOARD_BASE_URL` or `FRONTEND_URL`).
5. Confirmation that the in-process notifier replaces the proposed Streams + Lambda design.
6. AWS account and region to create the topic (`-c enableNotifications=true -c alertEmails=...`), and approval to deploy (item 14).

Env vars to set on the backend: `NOTIFICATIONS_ENABLED=true`, `INTEGRATION_MODE=live`, `ALERT_SNS_TOPIC_ARN`, `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL` (and `TEAMS_WEBHOOK_FORMAT` if legacy), `DASHBOARD_BASE_URL`, optionally `ALERT_POLL_MINUTES`, `NOTIFICATIONS_MAX_ALERT_AGE_MINUTES`, `NOTIFICATIONS_LOG_RETENTION_DAYS`, `NOTIFICATIONS_WEBHOOK_HOST_ALLOWLIST`. Recommended first step: `NOTIFICATIONS_DRY_RUN=true`, check the log, then use "Send test" per channel, then turn dry-run off.

## Files

Added: `docs/NOTIFICATIONS.md`, `infra/lib/notifications-construct.ts`, `packages/shared/src/notifications.ts`, `packages/backend/src/notifications/{channels,engine,guard,message,poller,runtime}.ts` (+ tests for channels, engine, guard, poller), `packages/backend/src/db/migrations/004_dpi2_notifications.sql`, `packages/backend/src/repositories/{sqlite,dynamodb}/notificationRepository.ts`, `packages/backend/src/routes/notificationRoutes.ts`, `packages/backend/src/routes/notifications.test.ts`, `packages/backend/src/services/notificationService.ts`, `packages/frontend/src/pages/Notifications.tsx`.
Changed: repository types and both driver indexes, alert repositories (`dataSource` filter), `alertService` (sync + trigger), `config`, `server.ts`, `apiRoutes.ts`, shared domain (audit actions), contract suite, migrations test, infra stack + check, frontend nav/routes/api/css/icons, `.env.example`, `packages/backend/package.json` + lockfile (`@aws-sdk/client-sns` 3.1162.0).
