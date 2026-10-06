# Urbani DPI — Honest Project Status Report

_Read-only investigation of the repository at `c:\Antigravity\Urbani DPI`. Status is judged from code, config, infra, tests, and data that actually exist — NOT from the forward-looking marketing documents in `OUTPUT/`._

## Executive summary (blunt)

Urbani DPI is a **well-built, fully-functional demo/MVP running entirely on mock and seeded data**, with **one genuinely live integration (reading logs from a real Urbani API Gateway endpoint)** and a **synth-ready but not-deployed CDK skeleton whose Lambda handlers are empty placeholders**. The web app is real: a React dashboard with login, alerts, logs, metrics, services, AI insights, an AI chatbot, usage/cost, audit, and settings — all wired to a working Express backend that persists to **SQLite** (not DynamoDB). The "AI" is a **deterministic `MockAIProvider`**; there is **no Bedrock client code in the backend app at all** (only placeholder Lambda stubs in `infra/`). The backend `.env` is set to `INTEGRATION_MODE=live` with a real API key, so logs genuinely flow from AWS API Gateway, but **everything else (metrics, services, alerts, AI, cost, audit) is mock/seed data** and clearly labelled as such in the UI. The build passes clean across all three workspaces and the full test suite is **21/21 green**, but test coverage is thin (adapters, auth, alerts only — no route/integration/frontend tests). To become a real deployed system, the project still needs: AWS account access + Bedrock model enablement, the real Bedrock/DynamoDB adapters written (the `aws` integration mode deliberately throws today), the two Lambda handlers implemented, auth/secret hardening, and an actual deployment.

## Status table

| Area | State | Evidence |
|---|---|---|
| Backend API (Express) | **Working** | `packages/backend/src/app.ts`, `routes/apiRoutes.ts` — all routes mounted & auth-guarded |
| Auth (JWT + bcrypt, seeded admin) | **Working** | `services/authService.ts`, `middleware/auth.ts`, `routes/authRoutes.ts` |
| Health / readiness probes | **Working** | `routes/healthRoutes.ts` (`/health`, `/ready` with DB check) |
| Persistence | **Working (SQLite)** | `db/connection.ts` (better-sqlite3), `repositories/*`; DynamoDB only in mock/infra |
| Logs | **Mock-backed, LIVE path real** | `telemetryService.logs()` → CloudWatch adapter boundary; live via `HttpUrbaniLogsAdapter.ts` |
| Metrics | **Mock-backed** | `telemetryService.metrics()` hardcodes `source: 'MOCK'`; live adapter returns MOCK metrics |
| Services | **Mock-backed** | `telemetryService.services()` → `serviceRepository` (seeded MOCK rows) |
| Alerts (list / detail / acknowledge) | **Mock-backed** | `services/alertService.ts` — all return `source: 'MOCK'`, SQLite-backed |
| AI insights / analyze | **Mock-backed** | `services/aiService.ts` + `MockAIProvider.ts` (deterministic, no Bedrock) |
| AI Chatbot (`POST /chat`) | **Mock-backed, wired end-to-end** | `routes/apiRoutes.ts` + `services/chatService.ts` + `MockAIProvider.askLogs()` + frontend `Assistant.tsx` |
| Usage / cost | **Mock-backed** | `services/usageService.ts`, seeded usage records |
| Audit | **Mock-backed** | `apiRoutes.ts` audit route, `auditRepository`, hardcoded `source: 'MOCK'` |
| Settings | **Working (read-only)** | `services/settingsService.ts`; `PUT /settings` audits intent, mutates nothing |
| Real Bedrock AI provider | **Planned-only** | No backend Bedrock code; `buildAws()` in `integrations/index.ts` throws |
| DynamoDB persistence | **Planned-only (infra) / Mock (app)** | `MockDynamoDBAdapter.ts` writes to SQLite; CDK defines the real table |
| CDK infrastructure | **Scaffolded (synth-ready, not deployed)** | `infra/lib/*` constructs implemented; `bin/app.ts` |
| Lambda collector + writer | **Scaffolded (empty placeholders)** | `infra/lambda/collector/index.js`, `writer/index.js` return `NOT_IMPLEMENTED` |
| Frontend (React/Vite SPA) | **Working** | `packages/frontend/src/pages/*` (12 pages), `api/endpoints.ts`, provenance badges |
| Build | **Working** | `npm run build` succeeds for shared + backend + frontend |
| Tests | **Working but thin** | `npm test` → 21/21 pass across 5 files |

Legend: **Working** = functional with real logic; **Mock-backed** = functional UI/API but data is mock/seed; **Scaffolded** = code exists but inert/placeholder; **Planned-only** = not implemented.

---

## Backend detail

Express app in `packages/backend/src/app.ts` mounts: security headers, CORS (env-driven allow-list), JSON body limit, correlation-id middleware, unauthenticated health routes at both `/` and `/api`, `/api/auth`, and the authenticated `/api` router. Every route in `routes/apiRoutes.ts` is guarded by `requireAuth` (`apiRoutes.use(requireAuth)`). Request validation uses `zod` schemas per endpoint.

Endpoints that actually exist and are wired (`routes/apiRoutes.ts` unless noted):

- **Auth** — `POST /api/auth/login`, `/logout`, `GET /me` (`routes/authRoutes.ts`). **Working**: JWT issued/verified in `authService.ts`, bcrypt password compare, seeded admin.
- **Health** — `GET /health`, `GET /ready` (`routes/healthRoutes.ts`). **Working**; `/ready` runs `SELECT 1` against SQLite.
- **Dashboard** — `GET /dashboard/summary`, `/dashboard/health`. **Mock-backed** (`dashboardService`).
- **Alerts** — `GET /alerts`, `GET /alerts/:id`, `POST /alerts/:id/acknowledge`. **Mock-backed**, SQLite-persisted; acknowledge is audited (`alertService.ts`).
- **Logs** — `GET /logs`. Served through the CloudWatch adapter boundary (`telemetryService.logs()`); **LIVE when configured**, otherwise MOCK.
- **Metrics** — `GET /metrics`. **Mock-backed** (`telemetryService.metrics()` hardcodes `'MOCK'`).
- **Services** — `GET /services`, `GET /services/:id`. **Mock-backed**.
- **AI** — `GET /ai/analyses`, `GET /ai/analyses/:id`, `POST /ai/analyze`. **Mock-backed** (`aiService.ts`).
- **Chat** — `POST /chat` with per-route `rateLimit({ windowMs: 60_000, max: 30 })`. **Mock-backed, fully wired** (`chatService.ts`).
- **Usage** — `GET /usage`, `GET /usage/cost`. **Mock-backed**.
- **Audit** — `GET /audit`. **Mock-backed**; response literally includes `sourceNote: 'Application-level audit events (Phase 1). CloudTrail integration in Phase 2.'`
- **Settings** — `GET /settings`, `PUT /settings`. **Working but read-only**: `settingsService.update()` returns `{ accepted: false }` and only records audit intent.

## AI & chatbot detail

- **Chat endpoint is real and wired end-to-end.** `POST /api/chat` → `chatService.ask()` pulls the current log window via the CloudWatch adapter (`cloudwatch.getLogs(...)`, LIVE or MOCK), then calls `aiProvider.askLogs(...)`, records usage + audit, and returns a `Sourced<ChatAnswer>` including `logsSource`, `provider`, `modelId`, token counts, and citations (`services/chatService.ts`).
- **The only AI provider wired is `MockAIProvider`.** It is deterministic, keyword/heuristic-driven, and grounds answers only in supplied log lines (`integrations/ai/MockAIProvider.ts`). There is **no `BedrockAIProvider` and no AWS Bedrock SDK anywhere in `packages/backend`.**
- **Provider selection** lives in `integrations/index.ts`:
  - `mock` → `new MockAIProvider(config.bedrock.primaryModelId)`
  - `live` → `buildLive()` which starts from `buildMock()` (so AI stays Mock) and only swaps the CloudWatch adapter for `HttpUrbaniLogsAdapter` when `config.urbani.logsConfigured`.
  - `aws` → `buildAws()` which **throws**: `'INTEGRATION_MODE=aws is not implemented yet.'`
- The model id used in the mock response is config-driven (`BEDROCK_PRIMARY_MODEL_ID`, default `anthropic.claude-3-5-sonnet-20241022-v2:0`), so the UI *displays* a real-looking model id even though no model is called.
- **RAG question (user asked): not needed for the current design.** The chatbot already uses the correct pattern for this use case — it grounds answers in the current log window fetched at query time and cites specific log lines (`AIProvider.askLogs` / `MockAIProvider.askLogs`). That is lightweight, in-context grounding over a bounded (≤100-line) window, which is appropriate here. A full RAG stack (vector DB, embeddings, retrieval) would only be justified if you need semantic search over large historical log volumes beyond the latest window. For the stated goal ("ask questions related to the logs"), the existing grounding approach is sufficient; RAG can be added later behind the same `AIProvider` interface without UI changes if historical/semantic search becomes a requirement. **The current architecture is sound and does not need to change to add the chatbot — the chatbot is already present.**

## Live-vs-mock reality

- **`HttpUrbaniLogsAdapter` (`integrations/live/HttpUrbaniLogsAdapter.ts`) is a complete, real HTTP client.** It calls `GET {base}/logs/latest?service=...` with an `x-api-key` header, defensively maps varied upstream log shapes into the `LogEntry` contract, normalizes levels, caches per refresh window, serves stale cache on transient failure, and never logs/returns the key. Metrics intentionally fall back to MOCK (upstream returns 403).
- **It is selected at runtime only when** `config.integrationMode === 'live'` **and** `config.urbani.logsConfigured` (both `URBANI_API_BASE_URL` and `URBANI_API_KEY` present). See `buildLive()` in `integrations/index.ts` and the `urbani.logsConfigured` flag in `config/index.ts`.
- **The backend `.env` is actually configured for live logs:** `INTEGRATION_MODE=live`, `URBANI_API_BASE_URL` set to a real `*.execute-api.ap-south-1.amazonaws.com/prod` host, and a 40-char `URBANI_API_KEY` present. So in a running backend, **`GET /api/logs` would genuinely hit AWS API Gateway and return `source: LIVE`.** (Key names/presence verified only — no secret values are reproduced here.)
- **Honest caveat:** the live path is real and unit-tested with mocked `fetch` (5 tests in `HttpUrbaniLogsAdapter.test.ts` prove mapping, level normalization, filtering, error-without-key-leak, and MOCK-metrics fallback). I did **not** confirm the live endpoint responds right now — an outbound probe during this investigation hung/was interrupted, so real-time reachability is **unverified**. `docs/PHASE3_URBANI_LOGS_INTEGRATION.md` reports the live window is "often empty (`log_count: 0`)". So: the integration code is production-quality and selected, but in practice it frequently returns an empty window, and live reachability from this environment is unconfirmed.
- **Everything else is mock/seed**, and the code is honest about it: `metrics`, `services`, `alerts`, `ai`, `usage`, `audit` all hardcode `source: 'MOCK'` with a `MOCK_NOTE`.

## Persistence reality

- **The running backend uses SQLite, not DynamoDB.** `db/connection.ts` opens `better-sqlite3` at `config.db.sqlitePath` with WAL + foreign keys. All repositories (`alertRepository`, `telemetryRepository`, `userRepository`, `aiRepository`, `auditRepository`, `integrationRepository`) query SQLite. Schema in `db/migrations/001_initial_schema.sql`; a `data/urbani.sqlite` file exists.
- **DynamoDB exists only in two inert places:** (1) `MockDynamoDBAdapter.ts`, whose `putAlert`/`getAlert`/`queryAlerts` actually delegate to the **SQLite** `alertRepository` — so even "DynamoDB" writes land in SQLite; (2) the CDK `PersistenceConstruct` which *defines* a real `UrbaniAlerts` table but is not deployed. `DB_DRIVER` supports `dynamodb` as an enum value, but no DynamoDB driver is implemented in the app.

## Frontend detail

React + Vite SPA under `packages/frontend/src`. Twelve pages exist and are wired to the typed API client:

- `Login.tsx` (auth), `Dashboard.tsx`, `Alerts.tsx`, `AlertDetail.tsx`, `Logs.tsx`, `Metrics.tsx`, `Services.tsx`, `AIInsights.tsx`, **`Assistant.tsx` (the chatbot)**, `Usage.tsx`, `Audit.tsx`, `Settings.tsx`. Auth is enforced via `auth/RequireAuth.tsx` + `AuthContext.tsx`; data fetching via `hooks/useApi.ts`.
- **Data provenance is surfaced consistently** via a `SourceBadge` component (`components/ui.tsx`) rendering `LIVE` / `MOCK` / `WAITING` (`WAITING_FOR_INTEGRATION`). The Dashboard shows a prominent banner: "Phase 1 foundation. All values below are controlled mock/seed data." Pages pass `source="MOCK"` to `PageHeader`; AI Insights, Settings, and the chatbot render per-row/per-message badges.
- **The chatbot UI is present and correctly wired** to `POST /chat` via `chatApi.ask()` (`api/endpoints.ts` → `Assistant.tsx`). It sends service/environment + last-8-turn history, renders citations, a typing indicator, suggestion chips, and a `SourceBadge` reflecting `logsSource` (so it will show LIVE for the log window when live logs are active). It is labelled "Answers via MockAIProvider in Phase 1; Bedrock later with no UI change."
- The open file `api/endpoints.ts` is a clean typed wrapper over every documented endpoint (auth, dashboard, alerts, logs, metrics, services, ai, chat, usage, audit, settings) using a `Sourced<T>` envelope — consistent with the backend contract.

## Infra / CDK detail

- **Structure is complete and plausibly synthesizable** from source: `infra/bin/app.ts` instantiates `UrbaniDpiStack`, which composes five implemented constructs: `SecurityConstruct` (KMS CMK, CloudTrail, least-privilege collector/writer IAM roles), `PersistenceConstruct` (DynamoDB `UrbaniAlerts` table, PK `service_id` / SK `timestamp`, GSI `anomaly_type-index`, CMK encryption, PITR, RETAIN), `OrchestrationConstruct` (two Lambdas + EventBridge rate rule), `CostConstruct`, `DashboardConstruct`. `cdk.json` uses `ts-node`; `package.json` has `synth`/`diff`/`deploy`/`destroy` scripts and pins `aws-cdk-lib ^2.150.0`.
- **The two Lambda handlers are empty placeholders.** `infra/lambda/collector/index.js` and `writer/index.js` both just `console.log` and return `{ status: 'NOT_IMPLEMENTED' }`. The construct comments say so explicitly ("Lambda handler code is a documented PLACEHOLDER").
- **Not deployed, by design.** `package.json` description: "Synth-ready skeleton; not auto-deployed." `bin/app.ts` resolves account/region from context or `CDK_DEFAULT_*` (default region `ap-south-1`). I did **not** run `cdk synth` (per instructions). Judging from source, synth should work since constructs reference only standard CDK L2s and the Lambda asset directories exist; this is **unverified** without running the tool. Nothing references a resource that doesn't exist in-tree — the Lambda asset paths (`infra/lambda/collector`, `infra/lambda/writer`) are present.

## Test results

Ran `npm test` (→ `vitest run` in `@urbani/backend`). **Result: 21 passed / 21 total, 5 files, exit code 0** (~6.8s):

- `src/integrations/live/HttpUrbaniLogsAdapter.test.ts` — 5 tests
- `src/integrations/ai/MockAIProvider.test.ts` — 4 tests
- `src/services/alertService.test.ts` — 5 tests
- `src/services/authService.test.ts` — 4 tests
- `src/integrations/index.test.ts` — 3 tests

**What is NOT tested:** no route/HTTP-level tests (Express endpoints, auth middleware wiring, zod validation, rate limiting), no `chatService`/`aiService`/`telemetryService`/`dashboardService`/`settingsService`/`usageService` service tests, no repository/DB-migration tests, no `MockDynamoDBAdapter`/`MockCloudWatchAdapter` tests, **no frontend tests at all**, and **no infra/CDK tests** (no `cdk synth` assertion). Coverage is a thin slice of the lower layers.

## Build result

Ran `npm run build` at the root. **Succeeded** for all three workspaces:

- `@urbani/shared` — `tsc` clean.
- `@urbani/backend` — `tsc` clean + `copy-assets.js` copied migrations to `dist`.
- `@urbani/frontend` — `tsc -b && vite build` clean; 855 modules; emitted `dist/assets/index-*.js` (~600 kB, 172 kB gzip). Only warning: a Vite "chunk > 500 kB" advisory (cosmetic; no error).

Exit code 0. No type errors anywhere.

## Config / env summary (key names only — no secret values reproduced)

`.env.example`, root `.env`, and `packages/backend/.env` all share the same key set. Keys and what they gate:

- **App:** `NODE_ENV`, `APP_NAME`, `LOG_LEVEL`, `PORT`.
- **URLs/CORS:** `API_BASE_URL`, `FRONTEND_URL`, `CORS_ORIGIN` — gate absolute-URL building and the CORS allow-list (empty = same-origin behind proxy).
- **Auth:** `JWT_SECRET` (required; placeholder `change-me-in-local-env-only` rejected in production), `JWT_EXPIRES_IN`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` — gate JWT signing and the bootstrap admin.
- **DB:** `DB_DRIVER` (`sqlite`|`dynamodb`), `DATABASE_URL` (canonical; backend `.env` uses the Docker volume path `/data/urbani.sqlite`), `DB_SQLITE_PATH` (fallback) — select/locate the store.
- **Integration mode:** `INTEGRATION_MODE` (`mock`|`live`|`aws`) — selects adapters. **Backend `.env` is set to `live`.**
- **Live Urbani logs (Phase 3):** `URBANI_API_BASE_URL`, `URBANI_API_KEY` (secret), `URBANI_SERVICE`, `URBANI_REFRESH_MINUTES` — gate the `HttpUrbaniLogsAdapter`. In backend `.env` the base URL + key are **present** (verified by presence/length only).
- **AWS (placeholders):** `AWS_REGION`, `AWS_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — gate future AWS SDK adapters; `hasStaticCredentials` is derived from the latter two.
- **CloudWatch (placeholders):** `CLOUDWATCH_REGION`, `CLOUDWATCH_LOG_GROUP`, `CLOUDWATCH_MAX_LOG_LINES`, `CLOUDWATCH_QUERY_WINDOW_MINUTES`.
- **DynamoDB (placeholders):** `DYNAMODB_ALERTS_TABLE`, `DYNAMODB_GSI_ANOMALY_TYPE`.
- **Bedrock (placeholders, config-driven):** `BEDROCK_PRIMARY_MODEL_ID`, `BEDROCK_FALLBACK_MODEL_ID`, `BEDROCK_GUARDRAIL_ID`, `BEDROCK_TEMPERATURE`, `BEDROCK_MAX_TOKENS`, `BEDROCK_TOP_P` — displayed in Settings/AI; not yet calling a model.
- **Cost:** `COST_DAILY_BUDGET_USD`, `COST_MONTHLY_BUDGET_USD`, `COST_SOFT_ALERT_USD`, `COST_HARD_ALERT_USD`.
- **Scheduler:** `COLLECTOR_SCHEDULE_MINUTES` (and infra uses the same cadence for the EventBridge rule).

Secret-handling is sound: secrets are read from env only, never hardcoded, never returned by `/settings` (only presence flags), and the live adapter never logs/returns the API key.

## Reality vs proposal (where marketing docs over-claim)

- The `OUTPUT/` proposal/plan/deck are **forward-looking sales documents**; treat their "delivered"/"completed"/"done" wording as aspirational, not evidence. Per the user's own instruction, nothing should be described as completed except at final delivery.
- **"AI troubleshooting / Bedrock":** today this is a deterministic `MockAIProvider`. There is **no Bedrock call** in the running system. The UI even states it uses MockAIProvider in Phase 1.
- **"Serverless collection pipeline (Lambda + EventBridge + DynamoDB)":** the CDK defines it, but both Lambdas return `NOT_IMPLEMENTED` and nothing is deployed; the running app uses SQLite, not DynamoDB.
- **"Live AWS telemetry":** only **logs** are live (and often an empty window); metrics, services, alerts, usage, and AI are mock/seed.
- The internal `docs/PHASE*.md` notes are more trustworthy and largely match the code (e.g. PHASE3 accurately says metrics/services stay MOCK and the live window is often empty). One claim to re-verify: PHASE3's "live smoke test … returns source: LIVE" — the adapter is unit-tested, but live reachability was **not** confirmed in this investigation.
- **Minor provenance inconsistency to fix:** `db/seed.ts` hardcodes all integration rows as `mode='MOCK', status='WAITING_FOR_INTEGRATION'`. So the **Settings page will show CloudWatch as WAITING even when `INTEGRATION_MODE=live` is actually serving LIVE logs.** The badge there is seed-driven, not runtime-driven.

## Prioritized gaps to production

1. **AWS account access + Bedrock model enablement** (blocker for all real AI). Nothing can call a model until an account, region, and `bedrock:InvokeModel` access for the configured model ids are confirmed. Evidence: `buildAws()` throws; no SDK in backend.
2. **Implement the real `BedrockAIProvider`** behind the existing `AIProvider` interface (`analyzeTelemetry` + `askLogs`), then wire it in `integrations/index.ts` `buildAws()`/`buildLive()`. The seams are ready; the implementation is absent.
3. **Implement the two Lambda handlers** (`infra/lambda/collector/index.js`, `writer/index.js`) — CloudWatch Logs Insights query → Bedrock invoke (guardrail, temp 0.0) → validate → DynamoDB `PutItem`. Currently `NOT_IMPLEMENTED` stubs.
4. **Write the real `AWSDynamoDBAdapter`** (and decide whether the app writes to DynamoDB directly or stays SQLite with DynamoDB only in the collector pipeline). Today `MockDynamoDBAdapter` writes to SQLite.
5. **Decide the live-metrics/services story** — those endpoints return 403 upstream; either provision them or keep them explicitly MOCK. Fix the Settings seed so integration status reflects runtime mode, not a hardcoded `WAITING`.
6. **Verify the live logs endpoint actually responds** from the deployment network and that the window is non-empty during real incidents (reachability currently unverified; window often empty per PHASE3 notes). **Rotate the API key** — PHASE3 notes it was shared in plaintext.
7. **Auth / secret hardening before production:** replace seeded admin + default `JWT_SECRET`/`SEED_ADMIN_PASSWORD`, consider server-side token revocation (logout is client-side today), and move secrets to a secret manager. Evidence: `authService.ts` comment ("token invalidation … is client-side"), `.env.example` placeholders.
8. **Run and gate on `cdk synth` in CI** (not done here) and add infra assertion tests; add route/service/integration tests and at least smoke-level frontend tests — current suite (21 tests) omits the HTTP layer, services, repositories, infra, and the entire frontend.
9. **Actually deploy** (CDK is synth-ready-skeleton, explicitly not auto-deployed) and stand up the frontend/backend hosting + reverse proxy described in `docker-compose.yml` / `.env`.

---

### Verification commands used (this report)
- `npm test` (root → backend vitest): **21/21 pass**.
- `npm run build` (root → shared, backend, frontend): **success, exit 0**.
- `git -C "...Urbani DPI" log --oneline`: latest commit `27b4f4d` (architecture diagram), prior `eb9da52` added CDK + Phase 3 logs integration.
- Env key presence checked without echoing secret values. A live HTTP probe of the Urbani logs endpoint was attempted but interrupted/timed out — live reachability remains **unverified**.
