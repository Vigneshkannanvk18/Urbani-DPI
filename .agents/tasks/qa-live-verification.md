# Urbani QA Real-Data Integration — Verification Evidence

Implementation of `.agents/tasks/qa-live-design.md` (first iteration — no `qa-live-review.json`
existed) including the 5 mandatory review fixes from `qa-live-design-review.json`. All changes are
UNCOMMITTED, applied directly in `c:\Antigravity\Urbani DPI`.

## Commands run and results

### Backend type-check — CLEAN
`npx tsc -p tsconfig.json --noEmit` (cwd `packages/backend`) → exit 0, no output.

### Backend test gate — ALL GREEN (48 tests, 8 files)
`npm run test` (cwd `packages/backend` → `vitest run` with `src/test/setup.ts`) → exit 0:

```
 ✓ src/integrations/live/HttpUrbaniLogsAdapter.test.ts (8 tests)
 ✓ src/integrations/live/HttpUrbaniChatProvider.test.ts (8 tests)
 ✓ src/integrations/live/HttpUrbaniAlertsAdapter.test.ts (6 tests)
 ✓ src/services/alertService.test.ts (6 tests)
 ✓ src/integrations/ai/MockAIProvider.test.ts (4 tests)
 ✓ src/lib/markdown.test.ts (8 tests)
 ✓ src/integrations/index.test.ts (4 tests)
 ✓ src/services/authService.test.ts (4 tests)
 Test Files  8 passed (8)
      Tests  48 passed (48)
```

Notes on what each covers:
- **The 2 previously-failing logs tests are FIXED to the real QA shapes** (not weakened): the
  non-200 case now asserts graceful `source:'LIVE'` + `value:[]` (no throw); the ordering case asserts
  newest-first with an unparseable timestamp sorting LAST. Logs are read from `/logs/latest` +
  `/logs/history` (windows flattened), merged, de-duped, with level INFERRED from message text.
- **Nullable-confidence coverage (review fix #2a):** `HttpUrbaniAlertsAdapter.test.ts` maps a live
  flat alert and asserts `confidence === null` AND that the alert is NOT skipped. Because
  `mapMany()` runs `urbaniIncidentAlertSchema.safeParse(...)`, this test would FAIL if the shared
  schema were left non-nullable (the alert would be dropped and `res` empty). The standalone
  un-runnable shared test was NOT added.
- **Markdown-helper coverage (review fix #2b):** `src/lib/markdown.test.ts` imports the PURE,
  DOM-free helper from `@urbani/shared` and asserts: `javascript:` / `data:` / `vbscript:` / `file:`
  and scheme-less URLs are neutralized to `null`; a `javascript:` link renders as LITERAL text (no
  link token / no anchor); `http`/`https` are allowed; bold/italic/code/heading/list/blockquote/
  fenced-code parse. The thin React wrapper (`markdown.tsx`) is verified by `tsc -b` + `vite build`
  (below); it never uses `dangerouslySetInnerHTML`. No frontend test runner / dev deps were added.
- **Chat (AC8/AC9/AC10/AC11):** sends exactly `{service,question}` with the SELECTED service
  (payments test proves it), maps `answer` (markdown) + `model_id` + `evidence` counts→note,
  `citations:[]`; throws `ServiceUnavailableError` on non-2xx / network / unmappable-2xx (no mock
  answer, no key leak); `analyzeTelemetry` still delegates to Mock.
- **MockAIProvider (review fix via §B.23):** QA fixtures; `environment:'qa'` → severity `HIGH`; a
  bare `environment:'production'` re-run keeps the `CRITICAL` branch covered.
- **Acknowledge-survives-resync (AC7):** proven at the repository level in `alertService.test.ts`
  (`upsertLivePreservingStatus` → `acknowledge` → re-`upsertLivePreservingStatus` keeps ACKNOWLEDGED;
  body still refreshed; nullable confidence passes through).
- **Live-mode factory (AC18):** `integrations/index.test.ts` flips env + `vi.resetModules()` +
  `await import('./index')` and asserts `aiProvider.name==='HttpUrbaniChatProvider'`,
  `cloudwatch.kind==='CLOUDWATCH'`, `urbaniAlerts` defined; env restored in `finally`.

### Root build (shared + backend + frontend) — SUCCEEDS
`npm run build` (repo root) → exit 0:
```
> @urbani/shared  — tsc clean
> @urbani/backend — tsc clean + copy-assets
> @urbani/frontend — tsc -b && vite build → 865 modules transformed, built in ~6–7s
```
`vite build` is clean (the frontend `markdown.tsx` React wrapper and all QA-copy changes compile
and bundle). The shared `markdown` pure helper is consumed by the frontend via a Vite source alias
(`@urbani/shared/markdown` → `../shared/src/markdown.ts`) so Rollup reads its native ESM exports;
the backend/vitest consumes it through the normal `@urbani/shared` barrel. No new npm dependencies.

### AC17 grep gate — ZERO matches
Scoped grep over `packages/**/*.{ts,tsx,sql}` (excluding `**/dist/**`, `**/node_modules/**`) plus
`packages/backend/.env`, root `.env`, `.env.example`, `docker-compose.yml` for:
`urbani-app`, `urbani-core-api`, `urbani-worker`, `urbani-web`, `elasticbeanstalk`,
`elastic beanstalk`, `apac.amazon.nova-lite`, `amazon.nova-lite`, `830oi1gxng`, `ap-south-1`,
`production-eb`, `staging-eb`, `no live chat`, `mock fallback` → **CLEAN: zero matches**.
`packages/backend/dist/` was also re-checked after `npm run build` and is clean (regenerated from
corrected source).

## Review fixes applied (all 5)
1. Seed row id renamed `int-urbani-app` → `int-urbani-ecs` (kind stays `URBANI_APP`); seed deletes any
   stale `URBANI_APP` row whose id isn't the new one (token-free), so a re-seed leaves exactly one row.
2. Shared/nullable-confidence assertion moved into the backend alerts-adapter test; markdown URL
   sanitization + tokenization factored into the pure `@urbani/shared/markdown` helper and unit-tested
   in the backend vitest; React wrapper verified by `tsc -b` + `vite build`. No new runner/deps.
3. `chatService` wraps anything caught around `askLogs` into `ServiceUnavailableError`
   (`throw e instanceof ServiceUnavailableError ? e : new ServiceUnavailableError()`) → always a
   controlled 503, never a 500.
4. Residual "Nova Lite" code comments updated to "Nova 2 Lite" in `config/index.ts` and
   `settingsService.ts`.
5. `mockLogs`/`mockMetrics` generated from the ENABLED subset (main, payments) only.

---

# MANDATORY LIVE VERIFICATION (post-review) — 2026-10-08

This section records the live re-verification required after code review. It was run from
`c:\Antigravity\Urbani DPI` on Windows PowerShell with `$ProgressPreference='SilentlyContinue'`.
Secret hygiene: the API key was read from `packages/backend/.env` (`URBANI_API_KEY`) only, used
solely as a runtime `x-api-key` header, and scanned for in every saved response and every server
log — it was **NEVER printed, logged, returned, or written to any file**. All temporary probe/verify
scripts were deleted after the run. **Changes remain UNCOMMITTED.**

## Step 1 — BUILD/TEST GATE — PASS (re-confirmed)
- `npx tsc -p tsconfig.json --noEmit` (cwd `packages/backend`) → **exit 0, clean**.
- `npm run test` (root → `@urbani/backend` vitest with `src/test/setup.ts`) → **48 passed (8 files)**,
  including the 2 previously-failing logs tests (updated to real QA shapes, not weakened).
- `npm run build` (root: shared + backend + frontend) → **exit 0**; `vite build` → 865 modules,
  built clean. (The `node.exe` stderr line is the Vite CJS deprecation notice, exit 0.)

## Step 2 — RAW LIVE RE-PROBE (QA API Gateway) — PASS for BOTH services
Base `https://iq71gvk8oi.execute-api.us-east-1.amazonaws.com/qa`, header `x-api-key`. POST /chat
bodies were written to temp files and read back (inline capture truncates). Confirmed CURRENT shapes:

- **`GET /logs/latest?service=main|payments`** → `{ service_id, window_start, window_end,
  source_log_group, log_count, relevant_log_count, logs:[{timestamp, message}] }`. `main` had live
  entries; `payments` frequently idle (`logs:[]`). `message` is often a stringified JSON object with
  an embedded `level`.
- **`GET /logs/history?service=main|payments&limit=20`** → `{ service_id, count, windows:[{...,
  logs:[{timestamp, message}]}] }`. Flatten path `windows[].logs[]` confirmed.
- **`GET /alerts/latest?service=main|payments`** → FLAT top-level snake_case with `alert_id`,
  `anomaly_type`, `severity`, `summary`, `probable_cause`, `recommendation` (singular string), plus
  extra fields present on the wire (`evidence[]`, `source_log_group`, `model_id`, `status`). Both
  services returned a current alert (`alert_id` present).
- **`GET /alerts/history?...&limit=20`** → `{ service_id, count, alerts:[{...flat snake_case...}] }`.
  `main` 20 alerts, `payments` 8 alerts — all real Bedrock-generated analyses.
- **`POST /chat` {service, question}** for BOTH services → `{ service_id, question, answer:<MARKDOWN>,
  evidence:{log_windows, alerts}, model_id:"global.amazon.nova-2-lite-v1:0" }`. Real, distinct Nova 2
  Lite markdown answers (~4–5s). Matches §B.3 exactly (answer field is `answer`; `evidence` is an
  object of counts; `model_id` snake_case).

Note: the real `/alerts/*` payload carries more fields than §B.3 predicted (`evidence`,
`source_log_group`, `model_id`, `status`); the adapter maps the contracted subset and the extras are
ignored harmlessly — verified end-to-end below.

## Step 3 — END-TO-END THROUGH THE RUNNING BACKEND — PASS for BOTH services
- **DB reset + single-row seed:** deleted the SQLite DB and re-seeded. Verified the DB has **exactly
  one `URBANI_APP` row** (`int-urbani-ecs`), all 4 integration rows, and **exactly one** admin user
  (`admin@urbani.local`). (`DATABASE_URL` was pointed at `packages/backend/data/urbani.sqlite` for
  the bare-metal run; the `.env` default `/data/urbani.sqlite` is a Docker-volume path. Seed used the
  documented `FORCE_DB_SEED=yes` override since `NODE_ENV=production`.)
- **Backend started as a BACKGROUND process** (`node dist/server.js`, never a blocking foreground dev
  server). Health: `{status:ok, env:production, integrationMode:live}`. A stale foreground
  `ts-node-dev` server from a prior step was holding port 4000 and was stopped first.
- Logged in with the seeded admin (JWT obtained).
- **`GET /api/logs?service=main`** → `source:"LIVE"`, 20 items; each has ISO `timestamp`, inferred
  `level` (WARN/ERROR), `service:"main"`, `environment:"qa"`, non-empty `message`, newest-first.
- **`GET /api/logs?service=payments`** → `source:"LIVE"`, `items:[]` (honest idle, no fabrication).
- **`GET /api/alerts?service=main|payments`** → `source:"LIVE"`; alerts mapped from flat snake_case:
  `alert_id→alertId`, `anomaly_type→anomalyType`, `probable_cause→probableCause`,
  `recommendation(string)→recommendedActions[1]`, `service_id→service`, `confidence:null`,
  `environment:"qa"`, `modelId:"global.amazon.nova-2-lite-v1:0"`, `evidence:[]` (no fabrication).
- **`POST /api/chat` {service:"main"}** and **{service:"payments"}** → `source:"LIVE"`,
  `provider:"HttpUrbaniChatProvider"`, `modelId:"global.amazon.nova-2-lite-v1:0"`, real Nova 2 Lite
  MARKDOWN answers (distinct per service — payments answer references payments alerts/403s, main
  references wallet/DB/Redis), `citations:[]`, `sourceNote` naming grounding counts (3 log windows,
  3 alerts). NOT mock phrasing, NOT a fallback.
- **Acknowledge survives resync (AC7):** acknowledged a live `payments` alert → status
  `ACKNOWLEDGED by admin@urbani.local`; a subsequent re-list (resync) kept it `ACKNOWLEDGED` (did not
  revert to OPEN).
- **AI Insights (AC13):** the `/ai/analyses` batch tool is honestly `source:"MOCK"` (no QA analyze
  endpoint, by design FR6). The "Live incident analysis" section is sourced per enabled service from
  `GET /api/alerts?service=…&pageSize=1` (verified LIVE) and badged LIVE — confirmed by code
  inspection of `AIInsights.tsx` (`LiveServiceAnalysis` → `alertsApi.list`).
- **Settings (AC14):** `integrationMode:"live"`; CloudWatch / Bedrock / DynamoDB / URBANI_APP rows all
  `mode:"LIVE", status:"CONNECTED"` (exactly one URBANI_APP row); Nova 2 Lite
  (`global.amazon.nova-2-lite-v1:0`); guardrail `UrbaniQaObservabilityGuardrail` id `0z947gmtk58a`
  version `1`; both ECS groups `/aws/ecs/urbaniqa-qa-main/app` + `/aws/ecs/urbaniqa-qa-payments/app`;
  collector 5 min; full pipeline resource names; enabled/disabled roster
  (main+payments enabled, auth+support disabled).
- **Services (AC15):** lists main+payments (enabled) and auth+support (disabled), each with its ECS
  log group. Services/metrics are honestly `source:"MOCK"` (QA exposes no live service discovery or
  metrics).
- **Key-leak scan:** every saved API response and both server log files were scanned for the API key
  → **NO leak** (key absent from all responses and logs).
- Background backend **STOPPED** when done.

## Step 4 — FRONTEND — PASS (vite build + API-layer + code inspection)
- `vite build` clean (Step 1). No browser/DOM automation tool is available in this environment, so
  **visual confirmation was done via the API layer (Step 3) + frontend code inspection** rather than
  a rendered browser.
- Data path confirmed: `api/endpoints.ts` maps 1:1 to the verified LIVE routes; every page consumes
  the `Sourced<T>` envelope and renders `SourceBadge` from `source`.
- Chatbot: `useAssistantChat.send()` → `chatApi.ask()` (`POST /api/chat`) with the selected service +
  history; on success renders `res.data.answer` via the XSS-safe `renderMarkdown` (no
  `dangerouslySetInnerHTML`; scheme-allowlisted links) and badges the bubble with **`res.source`**
  (AC16, so a 503/unavailable turn is never shown LIVE); on failure shows an honest "temporarily
  unavailable" error bubble — never a fabricated answer.
- Logs / Alerts / AI Insights / Services / Dashboard / Settings all read the verified-LIVE routes.

## Step 5 — FAULT TOLERANCE — PASS, then RESTORED
With the backend restarted against a deliberately-broken Urbani base URL (same API Gateway host, bad
stage path → upstream HTTP 403 on every call):
- **Logs:** `GET /api/logs?service=main` → HTTP **200**, `source:"LIVE"`, `items:[]` (degrades to
  empty honestly — no 500, no fabrication).
- **Alerts:** `GET /api/alerts` → HTTP **200**, `source:"LIVE"` with the previously-ingested rows
  still in SQLite (honest stale/persisted data, not a 500, not newly fabricated).
- **Chat:** `POST /api/chat` → HTTP **503** with body
  `{"error":{"code":"CHAT_UNAVAILABLE","message":"The AI assistant is temporarily unavailable.
  Please try again.","correlationId":…}}` — **no mock answer, no 500, no key leak**. The server log
  recorded `code:CHAT_UNAVAILABLE, statusCode:503` for every chat turn (one transient `INTERNAL_ERROR`
  observed in a probe was a test-harness artifact from a malformed curl JSON body, not the chat path).
- **Fault-mode server logs scanned → NO key leak.**
- **RESTORED:** backend restarted with the real base URL → `GET /api/logs?service=main`
  `source:"LIVE"` 20 items; `POST /api/chat` `source:"LIVE"` real Nova 2 Lite answer (2348 chars).
  Then stopped.

## Key-hygiene summary
The API key appeared in **NO** HTTP response body, **NO** server log line, and **NO** file written
during verification. All verification was done server-side; the key was only ever a runtime
`x-api-key` header. Temporary scripts were removed.

## What was verified LIVE vs. not
- **Verified LIVE (both main + payments):** raw QA GET endpoints (logs latest/history, alerts
  latest/history) and POST /chat; and end-to-end through the running backend — `/api/logs`,
  `/api/alerts` (snake_case→contract mapping), `/api/chat` (real Nova 2 Lite markdown, LIVE
  provenance, selected-service routing), acknowledge-survives-resync, Settings (LIVE/CONNECTED + full
  stack), Services roster, AI Insights live section (via alerts), and honest fault degradation
  (empty logs / stale alerts / 503 chat) with recovery.
- **Honestly MOCK by design (not a gap):** metrics, services discovery, dashboard aggregate label,
  and the batch `POST /ai/analyze` tool — QA exposes no live source for these; all clearly labeled.
- **Not verified via a rendered browser:** no DOM/browser automation tool was available in this
  environment; the frontend was proven at the API layer plus data-path/code inspection as noted in
  Step 4.
