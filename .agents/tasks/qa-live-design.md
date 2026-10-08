# Urbani QA — Real-Data End-to-End Integration (Requirements + Design)

Target working tree: `c:\Antigravity\Urbani DPI` (Windows, npm-workspaces monorepo: `packages/shared`, `packages/backend`, `packages/frontend`, `infra/`). Work DIRECTLY in this tree; changes stay **uncommitted** (real QA creds + SQLite live in gitignored files). No worktree/branch/commit.

Scope: author the requirements and lock the concrete technical design for wiring the **real Urbani QA AWS account** end-to-end across **both** live services (`main` + `payments`), **including a LIVE AI chatbot that calls the live `POST /chat` endpoint**, and removing the OLD single-service live wiring (`urbani-app` / `ap-south-1` / Elastic Beanstalk / `apac.nova-lite` / old key) **and the chatbot's mock answer fallback**. Implementation is a later step; the design reviewer gates this document.

> **AUTHORITATIVE CORRECTION over any prior version of this file.** A previous draft of this document assumed **there is no live `/chat` endpoint** and that chat should be composed server-side from `/alerts` + `/logs` with `MockAIProvider` kept as a free-form fallback. **That assumption is WRONG and is overwritten here.** The client has deployed the QA `/chat` route in API Gateway; it works with the existing `x-api-key` and was tested successfully for **both** `main` and `payments`, returning real Amazon Bedrock (Nova 2 Lite) answers grounded server-side in recent logs + alerts. The chatbot MUST use the live `POST /chat` for the selected service, and the `MockAIProvider` **answer** fallback MUST be removed in live mode (honest "temporarily unavailable" error instead). See §B.9 and §B.26 (corrections log).

---

# PART A — REQUIREMENTS

## A.1 Summary

The app runs on mock/seed data with a **partially-done, now-invalid** live integration that targets the OLD account (`830oi1gxng…ap-south-1…/prod`, service `urbani-app`), maps alerts from a wrapped camelCase shape, and (in the chat provider) silently falls back to a deterministic mock answer when the live call fails. The real QA account differs on every one of those points. We must make the app a **true real-data demo against QA for both `main` and `payments`**: genuine live logs (latest + history), genuine Bedrock-generated alert analyses, and a **live AI chatbot that calls `POST /chat`** and returns the real Nova 2 Lite answer — while preserving honest LIVE/MOCK provenance everywhere and never leaking the API key to the browser.

The repo is mid-refactor: backend `tsc` is clean, but **2 tests in `HttpUrbaniLogsAdapter.test.ts` already fail** (the adapter now degrades to `[]` instead of throwing on non-200, and the unparseable-timestamp line sorts to the top because it defaults to `now()`). The design corrects both and rewrites the chat/alerts adapter tests to QA reality so the **full suite goes green**.

## A.2 Functional requirements

- **FR1 — Both services everywhere.** Logs, alerts, AI insights, services, chat, and the dashboard must cover **both** `main` and `payments`. `auth` and `support` are surfaced as **registered but disabled** and are never called upstream.
- **FR2 — Live logs via latest + history.** The Logs page and (where applicable) grounding read live logs from `GET /logs/latest` **and** `GET /logs/history` (flattening `windows[].logs[]`), per service, merged and de-duplicated, so content is present even when the latest 5-minute window is idle (`payments` is frequently idle).
- **FR3 — Live alerts (flat snake_case).** Alerts read `GET /alerts/latest` and `GET /alerts/history` and map the real **flat, top-level, snake_case** alert shape onto the shared `UrbaniIncidentAlert` contract. Absence of `alert_id` on `/alerts/latest` means "no current alert" → `[]`.
- **FR4 — LIVE AI chat via `POST /chat`.** For the **selected** service the chatbot MUST call the live `POST {base}/chat` (header `x-api-key`, body `{service, question}`) and return the real Nova 2 Lite **markdown** answer with honest LIVE provenance (real `model_id`, grounding counts) and `citations: []` (never fabricated). The single frontend-facing route `POST /api/chat` is preserved.
- **FR5 — No mock answer in live mode.** On non-2xx / network error / timeout / abort, the live chat path returns an **honest "temporarily unavailable" error state** — **no fabricated or mock answer**, no key leak, and no unhandled 500 crash. (`MockAIProvider` is used for chat **only** when `INTEGRATION_MODE=mock`, i.e. a creds-free demo, clearly labeled MOCK.)
- **FR6 — AI Insights shows real analyses.** AI Insights displays the real live alert analyses (summary, probable cause, recommendation) for both services, labeled LIVE. The batch `POST /ai/analyze` tool has no QA endpoint and stays MOCK, clearly labeled.
- **FR7 — Settings/AI surface the real stack.** Settings and AI Insights surface: Amazon Nova 2 Lite (`global.amazon.nova-2-lite-v1:0`), guardrail `UrbaniQaObservabilityGuardrail` (`0z947gmtk58a` v1), the two ECS log groups, the 5-minute collector schedule, the pipeline resource names, and the enabled/disabled service roster.
- **FR8 — Runtime integration state reflects reality.** `settingsService` reports CloudWatch / Bedrock / alerts as LIVE/CONNECTED in live mode (not the seeded `WAITING`).
- **FR9 — Per-service UX.** Users can scope Logs, Alerts, AI Insights, and chat to a specific **enabled** service (`main`/`payments`) via a selector, and the dashboard aggregates across both. Disabled services (`auth`, `support`) are visible but not selectable for live calls.
- **FR10 — Remove old live wiring.** Replace every reference to the old account / model / log group / `/chat` claim in env files, `docker-compose.yml`, `config` defaults, `db/seed.ts`, mock data, adapter tests, and UI copy with QA reality.
- **FR11 — Honest provenance & markdown.** Every surface keeps a truthful LIVE / MOCK / WAITING label; the chat message badge reflects the **answer** provenance (not just the log-window source). The assistant renders the markdown answer. Data with no real QA source (metrics; batch analyze) stays MOCK. Empty windows are reported honestly with no fabricated citations.

## A.3 Non-functional requirements

- **NFR1 — Secret hygiene.** `URBANI_API_KEY` is read from env server-side only. It is never hardcoded, logged, returned in any API response, shipped to the browser, or written into this design. (It already lives in gitignored `.env` files.)
- **NFR2 — No new runtime npm deps.** Adapters use built-in `fetch` + `AbortController`. No AWS SDK, no RAG/vector/embeddings stack. Frontend markdown rendering uses a small, dependency-free, XSS-safe renderer (no new package).
- **NFR3 — Preserve seams.** Keep the adapter-behind-interface boundaries, the `AIProvider` contract, and the single frontend-facing chat route `POST /api/chat`.
- **NFR4 — No regressions.** `npm run build` (shared + backend + frontend) and the canonical backend test gate **`npm run test`** must pass; the 2 currently-failing logs-adapter tests and the now-stale chat/alerts tests are fixed/rewritten as part of this work. The gate is `npm run test` from the repo root (which runs `vitest run` in the `@urbani/backend` workspace, so its `src/test/setup.ts` applies), equivalently `npm run test --workspace @urbani/backend` or `vitest run` with cwd `packages/backend`. It is **NOT** a bare root `npx vitest run`: there is no root Vitest workspace, so from the repo root Vitest skips the backend `setupFiles` — leaking the real `.env`'s `INTEGRATION_MODE=live` + QA creds into the mock-mode `index.test.ts`/`alertService.test.ts` cases — and also sweeps in the `node:test` suite `scripts/gen-diagram.test.js` (which Vitest reports as a failed suite). See §B.28 (review iteration-2 Finding 3).
- **NFR5 — Resilience.** A single service, endpoint, or an expired key must degrade gracefully (empty/stale logs, empty alerts, honest chat "unavailable") and never 500 a page or crash chat.
- **NFR6 — Timeout.** The live `POST /chat` call uses an `AbortController` with ~30s headroom (Bedrock responds in ~5s).

## A.4 Acceptance criteria (specific, testable, numbered)

1. With `INTEGRATION_MODE=live` and QA env configured, `GET /api/logs` returns `source: "LIVE"` and, for a service with history, non-empty `items` sourced from `/logs/latest` + flattened `/logs/history`; each item has a valid ISO `timestamp`, a `level` inferred from message text, `service ∈ {main,payments}`, `environment: "qa"`, and a non-empty `message`.
2. `GET /api/logs?service=payments` returns only `payments` entries; when both its latest and history windows are idle it returns `items: []` with `source: "LIVE"` (no stale fabrication).
3. `GET /api/logs` never throws on an upstream non-200/timeout: it returns `source: "LIVE"`, `items: []` (or stale cache), not a 500. (Covers the first currently-failing logs test, now rewritten to assert graceful `[]`.)
4. Log ordering is newest-first; an entry whose timestamp is missing/unparseable sorts **last**, not first. (Covers the second currently-failing logs test.)
5. `GET /api/alerts` returns `source: "LIVE"` with alerts for both services mapped from the flat snake_case shape: `alert_id→alertId`, `anomaly_type→anomalyType`, `probable_cause→probableCause`, `recommendation(string)→recommendedActions` (single-element array), `summary/severity/timestamp` passed through, `service_id→service`, `evidence: []`, `confidence: null`, `modelId:` the Nova 2 Lite label.
6. `GET /alerts/latest` with no `alert_id` yields no alert for that service (`[]`); a present `alert_id` yields exactly one latest alert.
7. `GET /api/alerts/:id` detail and `POST /api/alerts/:id/acknowledge` still work on a live alert, and a periodic re-sync does **not** revert an acknowledged alert to OPEN.
8. `POST /api/chat` with `{question, service:"main"}` makes exactly one `POST {base}/chat` call with header `x-api-key` and body `{service:"main", question}`, and returns `source: "LIVE"`, `provider: "HttpUrbaniChatProvider"`, `modelId: "global.amazon.nova-2-lite-v1:0"`, the real markdown `answer`, `citations: []`, and a `sourceNote` naming the grounding counts (`N` log windows, `M` alerts).
9. `POST /api/chat` with `{service:"payments"}` sends `service:"payments"` in the `/chat` body (the selected service, not a fixed default).
10. In live mode, when the live `/chat` call returns non-2xx or the request throws/times out, `POST /api/chat` responds with a controlled **HTTP 503** `{error:{code:"CHAT_UNAVAILABLE", message:"<safe, no key>"}}` — never a mock/fabricated answer, never a 500, and the key never appears in the body or logs. The assistant UI shows an honest "temporarily unavailable" message.
11. In `INTEGRATION_MODE=mock`, `POST /api/chat` still returns a `source: "MOCK"`, `provider: "MockAIProvider"` answer (creds-free demo), clearly labeled MOCK.
12. The API key never appears in any HTTP response body, server log line, or the frontend bundle. `JSON.stringify` of every live adapter/provider result excludes the key (asserted in unit tests).
13. AI Insights shows a LIVE section with the latest live alert analysis (summary, probable cause, recommendation) per enabled service, badged LIVE.
14. Settings shows integration mode `live`; CloudWatch, Bedrock, and the alerts/DynamoDB integration rows as LIVE/CONNECTED; Nova 2 Lite; guardrail name `UrbaniQaObservabilityGuardrail` + id `0z947gmtk58a` + version `1`; both ECS log groups `/aws/ecs/urbaniqa-qa-main/app` and `/aws/ecs/urbaniqa-qa-payments/app`; collector schedule 5 min; the pipeline resource names; and the enabled/disabled roster.
15. The Services page lists `main` and `payments` as enabled and `auth` and `support` as disabled, each with its ECS log group; the Logs/Alerts/AI-Insights/chat service selectors offer only enabled services.
16. The assistant renders the markdown answer (headings, lists, bold/italic, inline + fenced code) safely, and the per-answer badge reflects the **answer** provenance (`res.source`), so a 503/unavailable turn is never shown with a LIVE badge.
17. The old-account wiring is removed from all code, env, and UI. A grep **scoped to** `packages/**/*.{ts,tsx,sql}` (source only), the env files (`packages/backend/.env`, root `.env`, `.env.example`), and `docker-compose.yml` — and **excluding** `.agents/`, `docs/`, `OUTPUT/`, and build artifacts (`**/dist/**`, `**/node_modules/**`) — returns **zero** matches for `urbani-app`, `urbani-core-api`, `urbani-worker`, `urbani-web`, `/aws/elasticbeanstalk/urbani-app`, `elasticbeanstalk`, `apac.amazon.nova-lite-v1:0`, `830oi1gxng`, `ap-south-1`, `production-eb`, `staging-eb`, or "no live chat"/"mock fallback" copy. The first three excluded trees are design/narrative/sales/historical artifacts that necessarily quote the old values (including this document, the review, and `.agents/_logs2.txt`); `dist/` is **compiled output** that `npm run build` regenerates clean from the corrected source (e.g. the copied `001_initial_schema.sql`), so once the source matches are gone a rebuild clears `dist/` automatically. The scope is what makes the gate meetable: the forbidden strings legitimately remain only in excluded narrative files and regenerable build output.
18. `npx tsc -p tsconfig.json --noEmit` is clean for backend; `npm run build` succeeds for all three workspaces; the canonical backend test gate **`npm run test`** (→ `vitest run` in `@urbani/backend` with `src/test/setup.ts`; equivalently `npm run test --workspace @urbani/backend`) passes with: the logs/alerts/chat adapter tests rewritten to QA shapes (including the 2 previously-failing logs tests and the chat test whose fallback expectation is inverted to "throws"); the `MockAIProvider.test.ts` severity assertion updated to the QA-honest value plus a retained CRITICAL-branch assertion (§B.23); the live-mode factory assertion done via a fresh-config dynamic import; and the acknowledge-survives-resync invariant exercised at the repository level (§B.22). It is **not** a bare root `npx vitest run` (see NFR4 / §B.28 Finding 3).
19. Whichever `.env` the backend loads (bare-metal `packages/backend/.env` or Docker via root `.env` + `docker-compose.yml`) resolves to the QA account; no path resolves to the old account.

## A.5 Out of scope

- Deploying the CDK stack or implementing the two Lambda handlers (`infra/lambda/*`).
- A real DynamoDB driver in the app (persistence stays SQLite; alerts are ingested-on-read from the `/alerts` API).
- Live metrics / live service discovery (QA exposes neither; both stay MOCK, clearly labeled).
- A real Bedrock SDK client in the backend, RAG/vector store, or a live batch `POST /ai/analyze` endpoint (stays MOCK; the live chat already runs through Bedrock server-side via `POST /chat`).
- Auth/secret-manager hardening, key rotation, and JWT changes (noted but not implemented here).
- `auth` / `support` service enablement (disabled upstream).

## A.6 Assumptions (explicit)

- **The QA endpoint shapes in §B.3 are the design target but are treated as a to-confirm contract, not ground truth** (the only in-repo probe, `.agents/_logs2.txt`, is the OLD account). The §B.0 gating pre-step re-probes the live QA account and reconciles field names **before** any mapper is edited; adapters stay defensive regardless.
- QA log entries carry **only** `timestamp` + `message` (no `level`); level is inferred from message text. The adapter still defensively unwraps a JSON-string `message` and uses an embedded `level` if present, so it is correct whether QA sends plain text or stringified JSON.
- The QA Urbani environment label is `qa` (used for `LogEntry.environment` / `UrbaniIncidentAlert.environment`, and for seed/mock/chat defaults).
- `recommendation`, `summary`, and `probable_cause` are single strings; `/alerts/*` returns no `evidence`, `confidence`, `modelId`, or `environment`.
- The live `/chat` response's `evidence` is an **object of counts** `{log_windows, alerts}` (not a citation array); `model_id` is snake_case; no token counts are returned.
- The pipeline resource names/IDs (lambda names, EventBridge rule, guardrail name/version, log groups) are **non-secret** and may be shown in the UI.
- `dotenv` applies **last-wins** for duplicate keys within a single file and does **not** override already-set `process.env`. `packages/backend/.env` therefore already resolves to QA for keys re-declared in its bottom block; the design still de-duplicates it and fixes the keys that are only declared (stale) in the top block.

---

# PART B — TECHNICAL DESIGN

## B.0 Gating pre-step — PIN the live response shapes before editing any mapper (do FIRST)

**(Added in response to review Finding 3.)** The field-name mappings in §B.3 / §B.6.2 / §B.7.1 / §B.9.1 are derived from the authoritative task facts and the user's confirmation that `/chat` now works — but the exact JSON of the QA `/chat`, `/logs/history`, and `/alerts/*` responses has **not** been observed in this repo (the only committed probe, `.agents/_logs2.txt`, is the **OLD** account). Treat §B.3 as a **to-confirm contract, not ground truth.** Before touching the chat/logs/alerts mappers, the implementer MUST capture one real response of each and reconcile the field names. This is a hard gate because a wrong `/chat` answer-field name is the single highest-impact risk in this redesign.

**Procedure (server-side; key read from env, never printed, pasted, or committed):**
1. Load the QA base URL + key from the gitignored env **without echoing the key**. PowerShell, from the repo root:
   - `$base = 'https://iq71gvk8oi.execute-api.us-east-1.amazonaws.com/qa'`
   - `$key = ((Get-Content 'packages/backend/.env' | Select-String '^URBANI_API_KEY=') -replace '^URBANI_API_KEY=','').Trim()`
   - `$h = @{ 'x-api-key' = $key }`
2. Capture each body (do **not** save the key or the `x-api-key` header into any file):
   - `Invoke-RestMethod -Method Post -Uri "$base/chat" -Headers $h -ContentType 'application/json' -Body '{"service":"main","question":"Are there any errors right now?"}'` — then repeat with `"service":"payments"`.
   - `Invoke-RestMethod -Uri "$base/logs/history?service=main&limit=20" -Headers $h`
   - `Invoke-RestMethod -Uri "$base/alerts/latest?service=main" -Headers $h` — then repeat with `payments`.
3. Record ONLY the **key names and nesting** (values may be elided) of each response.

**Reconcile before coding (update the §B.3 table + the affected mapping table if any name differs):**
- **`/chat`:** confirm the answer field is literally `answer`; `evidence` is an object `{ log_windows, alerts }` (counts, not an array); the model-id key is `model_id` (snake_case). If the answer field differs, fix §B.9.1's primary field (and add the real name ahead of the defensive aliases) **before** implementing.
- **`/logs/history`:** confirm `windows[].logs[]` with `{ timestamp, message }`. If the structure differs, adjust §B.6's flatten path (the adapter also accepts a flat top-level `logs[]` as a fallback).
- **`/alerts/latest`:** confirm fields are **flat top-level snake_case** gated on `alert_id` (not wrapped in `alert`). If different, adjust §B.7.1.

**Gate / rationale:** per §B.9.1 the chat mapper now **throws an honest 503 rather than emit a canned answer under a LIVE badge** when it cannot find a recognizable answer field. That is the correct failure mode, but if the real field name were missed it would make *every* live turn 503 and defeat the demo. Pinning the shape here prevents that. **Secret hygiene:** the key is used only as a runtime `x-api-key` header during probing; it is never written into §B.3, this document, the probe notes, server logs, or any committed file.

## B.1 Overview

Everything flows through the existing seams. Three live sources sit behind interfaces the service layer already consumes:

- live **logs** — `HttpUrbaniLogsAdapter` satisfying `CloudWatchAdapter` (consumed by `telemetryService.logs()` and `chatService`);
- live **alerts** — `HttpUrbaniAlertsAdapter`, a focused source consumed by `alertService` via ingest-on-read into SQLite;
- live **AI chat** — `HttpUrbaniChatProvider` satisfying `AIProvider`, which **POSTs the live `/chat`** for the selected service.

The integration factory (`integrations/index.ts`) already selects these in `live` mode. The fixes are: (a) pass the **full enabled service list** + `environment` into each adapter so `payments` is surfaced; (b) **correct the alerts and logs field mappings** to the real QA shapes and fix the logs ordering/degradation bugs; (c) **correct the chat provider's response mapping** to the real `/chat` shape, make it send the **selected** service, and **remove the mock answer fallback** (honest 503 on failure); and (d) retire the `?minutes=N` logs window in favor of `/logs/history?limit=N`.

The frontend keeps its single `POST /api/chat` route and `Sourced<T>` provenance envelope; changes are UX (per-service selectors over enabled services, QA copy, markdown rendering, truthful per-answer badges, honest "unavailable" copy) and are expected.

Guiding principle: **honest provenance**. Live data is labeled LIVE; the real Bedrock chat answer is labeled LIVE; the creds-free demo answer is labeled MOCK; anything with no QA source (metrics, batch analyze) stays MOCK; a failed live chat is an honest 503, never a disguised mock answer. Nothing is fabricated — empty windows say so and cite nothing.

## B.2 Technology stack (LOCKED)

- **Runtime/language:** Node.js + TypeScript (strict), existing versions. Backend: Express + `zod` + `better-sqlite3` (SQLite persistence unchanged). Frontend: React + Vite + React Router + Recharts. Shared: `zod` contracts in `@urbani/shared`.
- **HTTP to QA:** built-in global `fetch` + `AbortController` — logs/alerts 15s timeout; chat ~30s timeout. Mirrors the existing `HttpUrbaniLogsAdapter`. **No new npm dependencies.**
- **AI:** no Bedrock SDK in the app. The chat answer comes from the live `POST /chat` (Bedrock Nova 2 Lite, server-side, guardrailed). `MockAIProvider` is used only in `INTEGRATION_MODE=mock` and for the `analyzeTelemetry` delegation (no live analyze endpoint).
- **Persistence:** SQLite via existing repositories. Alerts are ingested-on-read; no schema migration.
- **Frontend markdown:** a small in-house, XSS-safe renderer (no new dep). See §B.14.1.
- **Auth/transport/provenance:** unchanged (JWT bearer; `Sourced<T>` envelope; `SourceBadge`).

## B.3 QA endpoint shapes — PIN via the §B.0 probe before mapping (design against THESE)

> These shapes are the authoritative task facts + the user's "`/chat` works" confirmation. They are **not** yet observed in-repo; the §B.0 gating probe confirms the exact field names before any mapper is edited. Adapters stay defensive regardless.

```
GET /logs/latest?service=<svc>                         header: x-api-key
  200 { service_id, window_start, window_end, source_log_group,
        log_count:<number>, relevant_log_count, logs:[{ timestamp, message }] }
  payments often log_count:0, logs:[] (idle). Entries: timestamp + message only, NO level.

GET /logs/history?service=<svc>&limit=20               header: x-api-key
  200 { service_id, count, windows:[ { window_start, window_end, source_log_group,
        log_count, relevant_log_count, logs:[{ timestamp, message }] } ] }
  Flatten windows[].logs[] (newest-first). (Defensive: also accept a flat top-level logs[].)

GET /alerts/latest?service=<svc>                        header: x-api-key
  200 (fields FLAT at top level, snake_case):
      { service_id, timestamp, alert_id, anomaly_type, severity, summary,
        probable_cause, recommendation }     // recommendation is a SINGULAR STRING
  No evidence/confidence/modelId/environment fields.  No alert_id => no current alert => [].

GET /alerts/history?service=<svc>&limit=20              header: x-api-key
  200 { service_id, count, alerts:[ { same FLAT snake_case fields } ] }

POST /chat                                              headers: x-api-key, content-type: application/json
  body: { service:'main'|'payments', question:'<text>' }
  200 (~4-5s): { service_id, question:'<echoed>', answer:'<MARKDOWN string, real Nova 2 Lite>',
                 evidence:{ log_windows:N, alerts:M },   // OBJECT OF COUNTS, not an array
                 model_id:'global.amazon.nova-2-lite-v1:0' }   // snake_case; no token counts

Severities observed: MEDIUM. Keep full LOW/MEDIUM/HIGH/CRITICAL; default unknown -> MEDIUM.
Region us-east-1, env QA. Base URL https://iq71gvk8oi.execute-api.us-east-1.amazonaws.com/qa (gitignored .env).
Enabled: main, payments. Registered-but-disabled: auth, support (surface disabled, never call).
```

## B.4 Config — `packages/backend/src/config/index.ts`

Adjust the `zod` schema and the `config.urbani` / `config.bedrock` / `config.cloudwatch` blocks:

- `URBANI_SERVICE` default `main` (already correct). `URBANI_SERVICES` default `''` → parsed to `config.urbani.services` with `[service]` fallback (already correct) — the single source of the enabled list.
- **New** `URBANI_ENVIRONMENT` (default `qa`) → `config.urbani.environment`. The Urbani env label for logs/alerts/seed/chat (replaces hardcoded `'qa'` literals and the old `production-eb`).
- **New** `URBANI_LOGS_HISTORY_LIMIT` (coerce number, default `20`) → `config.urbani.logsHistoryLimit`. Windows requested from `/logs/history?limit=N`.
- **Retire** `URBANI_LOGS_WINDOW_MINUTES` / `config.urbani.logsWindowMinutes` and the `?minutes=N` logic (QA uses `/logs/history?limit=N`, not a minutes window). Remove the schema key, the config field, and both call-sites (logs adapter + chat provider constructors). An unknown leftover key in `.env` is harmless, but remove it from the env files for clarity.
- `URBANI_CHAT_MODEL_ID` default `apac.amazon.nova-lite-v1:0` → **`global.amazon.nova-2-lite-v1:0`**.
- `URBANI_CHAT_TIMEOUT_MS` default `20000` → **`30000`** (~30s headroom; Bedrock ~5s). `URBANI_ALERTS_HISTORY_LIMIT` (default `5`) — keep.
- `CLOUDWATCH_LOG_GROUP` default `/aws/elasticbeanstalk/urbani-app` → **`/aws/ecs/urbaniqa-qa-main/app`**. Keep the `logsConfigured` gate (base URL + key) unchanged.
- `BEDROCK_PRIMARY_MODEL_ID` default → `global.amazon.nova-2-lite-v1:0`; `BEDROCK_FALLBACK_MODEL_ID` default → `global.amazon.nova-2-lite-v1:0` (QA has a single model); `BEDROCK_GUARDRAIL_ID` default → `0z947gmtk58a`. (Env is authoritative in QA; defaults are corrected so an unset env never displays stale Claude/EB/guardrail values.)
- **New** `BEDROCK_GUARDRAIL_NAME` (default `UrbaniQaObservabilityGuardrail`) and `BEDROCK_GUARDRAIL_VERSION` (default `1`) → `config.bedrock.guardrailName` / `config.bedrock.guardrailVersion`. Non-secret display values.
- `AWS_REGION` default `us-east-1` — keep.

Derived helpers on `config.urbani`:

- `environment: string` (from `URBANI_ENVIRONMENT`).
- `logsHistoryLimit: number`.
- `logGroupFor(service: string): string` → `` `/aws/ecs/urbaniqa-${config.urbani.environment}-${service}/app` `` (matches the two provided groups; `auth`/`support` map consistently even though they are not polled).
- `logGroups: string[]` = enabled `services` mapped through `logGroupFor`. Used by seed + Settings display.

## B.5 Non-secret QA pipeline facts — new `packages/backend/src/config/urbaniQa.ts`

A small constants module (non-secret display copy) consumed by `settingsService` so `.env` stays focused on secrets/behavior:

```ts
export const URBANI_QA_PIPELINE = {
  region: 'us-east-1',
  collectorLambda: 'UrbaniTelemetryCollectorFn',
  eventBridgeRule: 'urbaniqa-qa-observability-collector-5m',
  collectorScheduleMinutes: 5,
  alertWriterLambda: 'UrbaniAlertWriterFn',
  duplicateSuppressionMinutes: 30,
  logsApiLambda: 'UrbaniLogsApiFn',
  alertsApiLambda: 'UrbaniAlertsApiFn',
  chatLambda: 'UrbaniChatFn',
  flow: 'ECS → CloudWatch Logs → Collector Lambda → Bedrock + Guardrail → Alert Writer → DynamoDB',
  registeredServices: [
    { name: 'main', enabled: true },
    { name: 'payments', enabled: true },
    { name: 'auth', enabled: false },
    { name: 'support', enabled: false },
  ],
} as const;
```

## B.6 Logs adapter — `packages/backend/src/integrations/live/HttpUrbaniLogsAdapter.ts`

Keeps the `CloudWatchAdapter` contract and the existing cache/stale/no-key-leak discipline. Changes:

- **Constructor** receives the full enabled `services` list, `historyLimit` (replaces `windowMinutes`), and `environment`. Signature:
  `(baseUrl, apiKey, service, refreshMinutes, historyLimit, services?, environment?)`.
- **`getLogs(query)`** fans out across the target services (the requested `query.service` if it is enabled, else all enabled), and for each service fetches **both** `/logs/latest` **and** `/logs/history?limit=N`, flattens `windows[].logs[]` (defensively also accepting a flat top-level `logs[]`), **merges** latest ∪ history. Mapping produces, per entry, a tuple `{ entry: LogEntry, sortKeyMs: number }` (see the ordering fix). It **de-duplicates** on the natural key `` `${service}|${sortKeyMs}|${message}` `` (same inputs as the id hash in §B.6.2, so id and dedup stay consistent), applies filters (service/environment/level/search) to `tuple.entry`, **stable-sorts the tuples by `sortKeyMs` descending**, caps at `min(query.limit ?? 100, 100)`, and finally returns `tuples.map((t) => t.entry)`. Meta stays `source: 'LIVE'` with a note naming the services + refresh cadence.
- **Ordering fix (AC4 / failing test #2) — concrete plumbing (review Finding 4):** `mapLogs` computes `sortKeyMs = parsedEntryMs ?? enclosingWindowEndMs ?? -Infinity`, where `parsedEntryMs = Date.parse(entry.timestamp)` (dropped when `NaN`), and `enclosingWindowEndMs = Date.parse(window_end)` of the history window the entry came from (for `/logs/latest`, the response-level `window_end`). The merge/dedup/filter steps operate on the `{ entry, sortKeyMs }` tuples; the final step **stable-sorts by `sortKeyMs` descending** (a stable sort keeps upstream order for equal keys). An entry with no resolvable timestamp gets `sortKeyMs = -Infinity` and therefore sorts **last**, never first — fixing the currently-failing test, where a `now()` fallback outsorted real 2026 timestamps. The human-facing `LogEntry.timestamp` keeps its **own, separate** display fallback (entry ts → `window_end` → `now()`); only `sortKeyMs` governs ordering.
- **Error handling fix (AC3 / failing test #1):** per-service fetch failures are caught; serve stale cache for that service if present, else `[]`. `getLogs` **never throws**, so the Logs page degrades to empty instead of 500. The `IntegrationError` throw-on-non-200 is removed from this path; the old test asserting a reject on 403 is rewritten to assert graceful `[]` + `source:'LIVE'`.
- **Per-service cache** keyed by service (TTL = refresh window) is retained; add a separate history cache entry per `service:limit` (mirrors the alerts adapter) so latest and history refresh independently.
- **`getMetrics`** unchanged — MOCK with a clear note (QA has no metrics endpoint).

### B.6.1 Level inference (QA logs have no `level`)

`inferLevel(entry)` precedence:
1. If the entry (or an unwrapped JSON-string `message`) exposes an explicit `level`/`severity`, normalize and use it (`WARNING→WARN`, `ERR/CRIT/CRITICAL→ERROR` or `FATAL`, etc.) — preserves correctness if QA sends stringified JSON.
2. Else scan the message text, case-insensitive, word-boundary, in priority order: `FATAL|CRITICAL → FATAL`; `ERROR|ERR|EXCEPTION|FAIL|FAILED|TIMEOUT → ERROR`; `WARN|WARNING → WARN`; `DEBUG|TRACE → DEBUG`; else `INFO`.
3. Default `INFO`.

### B.6.2 Logs field mapping (`→ LogEntry`)

| LogEntry field | Source | Rule |
|---|---|---|
| `id` | derived (deterministic) | `` `${service}:${sortKeyMs}:${shortHash}` `` where `shortHash = crypto.createHash('sha1').update(\`${service}|${sortKeyMs}|${message}\`).digest('hex').slice(0, 12)` — i.e. the hash input is **the same natural key used for dedup** (§B.6), so id and dedup stay consistent and the id is deterministic/stable across re-fetch and bounded in length (good React key). `crypto.createHash` is already available from `node:crypto` (the adapter imports `randomUUID` from it today). Replaces the undefined `hash()` reference (review Finding 5). |
| `timestamp` | `logs[].timestamp` | ISO-normalize for **display** only; fallback enclosing `window_end`; else `now()`. This is independent of `sortKeyMs` (§B.6), which is `-Infinity` for an unresolved timestamp so the row still sorts last. |
| `level` | message text / embedded | `inferLevel()` (B.6.1) |
| `service` | queried service / `service_id` | the fanned-out service tag |
| `environment` | — | `config.urbani.environment` (`qa`) |
| `message` | `logs[].message` | plain text, or unwrapped inner `message` if the field is a JSON object string |

## B.7 Alerts adapter — `packages/backend/src/integrations/live/HttpUrbaniAlertsAdapter.ts`

Rewrite the response parsing + mapping to the **real flat snake_case** shape; keep the per-service TTL cache, stale-on-failure, `[]`-on-failure, and no-key-leak discipline. Constructor receives the full enabled `services` list + `environment`:
`(baseUrl, apiKey, service, refreshMinutes, services?, environment?)`.

- **`/alerts/latest?service=<svc>`** → treat the **top-level body** as the alert. If `alert_id` is absent → `[]` for that service (no current alert). (Not `body.alert` — the real shape is **not** wrapped.)
- **`/alerts/history?service=<svc>&limit=N`** → `body.alerts` (array of flat objects); `limit` = `config.urbani.alertsHistoryLimit`.
- Fan-out `getLatest()` / `getHistory(limit)` across enabled services and flatten (already implemented).
- Validate each mapped object against `urbaniIncidentAlertSchema.safeParse`; skip malformed entries with a `warn` (alertId + failing paths). Requires the nullable-confidence contract change in §B.8.

### B.7.1 Alerts field mapping (`→ UrbaniIncidentAlert`)

| UrbaniIncidentAlert field | QA source (snake_case, flat) | Rule |
|---|---|---|
| `alertId` | `alert_id` | required; absent on `/latest` ⇒ no alert (`[]`); on `/history` skip the entry if missing |
| `timestamp` | `timestamp` | ISO-normalize (offset-aware); fallback `now()` |
| `service` | `service_id` | ⇒ `service`; fallback queried service |
| `environment` | — (not provided) | `config.urbani.environment` (`qa`) |
| `severity` | `severity` | normalize to enum; unknown ⇒ `MEDIUM` |
| `anomalyType` | `anomaly_type` | fallback `UnknownAnomaly` |
| `summary` | `summary` | fallback `''` |
| `probableCause` | `probable_cause` | fallback `''` |
| `recommendedActions` | `recommendation` (STRING) | `recommendation.trim() ? [recommendation] : []` (single-element array; never split) |
| `evidence` | — (not provided) | `[]` (never fabricated) |
| `confidence` | — (not provided) | `null` (see §B.8; rendered `—`, not a fabricated %) |
| `modelId` | — (not provided) | `config.urbani.chatModelId` (`global.amazon.nova-2-lite-v1:0`) |

The current adapter reads `body.alert` + camelCase fields and defaults confidence to `0.5`; all three are wrong for QA and are replaced per the table above.

## B.8 Shared contract change — nullable confidence (`packages/shared/src/alerts.ts`)

**Decision:** the QA `/alerts/*` API returns no confidence score. Option (a) map missing confidence to a fixed number (e.g. `0.5`); option (b) make `confidence` nullable and render `—`. **Choose (b).** A fixed number paints a precise, fabricated confidence onto a LIVE-labeled incident, violating the honest-provenance constraint; nullable + `—` is the truthful realization of "unknown." Blast radius is small — the persistence and UI layers already tolerate null.

Exact edits:
- `urbaniIncidentAlertSchema.confidence`: `z.number().min(0).max(1)` → `z.number().min(0).max(1).nullable()`. `persistedAlertSchema` inherits it; `UrbaniIncidentAlert`/`PersistedAlert` types become `confidence: number | null`.
- `alertRepository.rowToAlert`: `confidence: row.confidence ?? 0` → `confidence: row.confidence` (pass `null` through). `insert` / `upsertLivePreservingStatus` already bind `alert.confidence` (SQLite accepts `null`).
- `HttpUrbaniAlertsAdapter.mapOne`: `confidence: null` (field not present in QA).
- `MockAIProvider` and `mockData` keep **numeric** confidence (still valid under the widened type).
- Frontend: `Confidence` already renders `null → —`; `AIAnalysis.confidence` is already `number | null`. No frontend change required for this.

## B.9 Chat — `packages/backend/src/integrations/live/HttpUrbaniChatProvider.ts` (KEEP; fix mapping + remove fallback)

**Keep** the class and its POST to `POST {base}/chat`. The required changes are: send the **selected** service, correct the response mapping to the real shape, bump the timeout, and **remove the `MockAIProvider` answer fallback** in `askLogs`.

- `name = 'HttpUrbaniChatProvider'`; `modelId = config.urbani.chatModelId` (Nova 2 Lite). Keep an internal `MockAIProvider(modelId)` **only** for `analyzeTelemetry` delegation (no live analyze endpoint); `askLogs` **never** calls it.
- Constructor: `(baseUrl, apiKey, service, modelId, timeoutMs)` — **drop** the `windowMinutes` parameter.
- **`askLogs(input)`** POSTs with headers `{ 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' }` and body **exactly** `{ service: resolveService(input.service), question: input.question }` (no `minutes`), under an `AbortController` with `timeoutMs` (~30s). This is the **multi-service fix**: the current code always sends the constructor's fixed `service`, so `payments` chat would silently query `main` (AC8/AC9).
- **`resolveService` is PRESENCE-ONLY (review Finding 2):** `resolveService(s) = (typeof s === 'string' && s.trim()) ? s : this.service`. It does **not** re-check "enabled" — enablement is `chatService`'s responsibility (§B.9.2), and `chatService` only ever passes an already-validated enabled service (or the default `main`) as `input.service`. The provider must therefore **never** rewrite a provided service back to the default; doing so would silently send a valid `payments` request to `main` and break AC9. No services list is threaded into the provider (its constructor takes none — see §B.10).
- **On success (2xx)** map per §B.9.1. If a 2xx body is **unmappable** (no recognizable answer field — a shape mismatch, see §B.9.1), `mapResponse` throws `ServiceUnavailableError` as well, so the turn surfaces as an honest 503 rather than a canned answer under a LIVE badge.
- **On non-2xx / network error / timeout / abort:** **throw** `ServiceUnavailableError` (new; §B.15) with a safe message `'The AI assistant is temporarily unavailable. Please try again.'` — **no key, no stack, no mock/fabricated answer.** `chatService` surfaces this as a controlled 503 (§B.9.2). This is the removal of the mock answer fallback (FR5/AC10).
- `analyzeTelemetry(input)` → `return this.fallback.analyzeTelemetry(input)` (documented MOCK delegation; `aiService` already labels its result from `meta.source`).
- SECURITY: the `apiKey` only ever appears in the `fetch` header — never in `meta`/`answer`/`sourceNote`/thrown messages/logs.

### B.9.1 Response mapping (live `/chat` 200 → `AskLogsResult`)

| AskLogsResult field | QA `/chat` source | Rule |
|---|---|---|
| `answer` | `answer` (markdown string) — **pin exact name via §B.0** | Resolve the first non-empty string among `body.answer` → defensive aliases `body.response` / `body.message` / `body.text` / `body.content`. Pass through **verbatim** (markdown preserved; rendered client-side). If **no** recognizable non-empty answer string is present on a 2xx body, that is a shape mismatch, **not** a valid empty answer: log a safe warning (no key, no secret payload) and **throw `ServiceUnavailableError`** so the turn surfaces as an honest 503 — never a canned string under a LIVE badge (review Finding 3). The §B.0 probe must confirm the real field name so the primary path, not the alias/throw path, is taken. (A genuinely empty live window still returns a real `answer` string from Bedrock, so "empty window" is distinct from "no answer field".) |
| `citations` | — (none in response) | **`[]`** — never invented. (The real grounding is counts, not lines; see note.) |
| `modelId` | `model_id` (snake_case) | `body.model_id` (string, non-empty) else `this.modelId` (Nova 2 Lite). Also tolerate a legacy `modelId` key defensively. |
| `provider` | — | `this.name` (`HttpUrbaniChatProvider`) |
| `inputTokens` | — (none) | estimate `min(ceil(question.length/4), 1500)` |
| `outputTokens` | — (none) | estimate `ceil(answer.length/4)` |
| `guardrailIntervened` | — (not exposed on `/chat`) | `false` |
| `meta.source` | — | `'LIVE'` |
| `meta.note` | `evidence.{log_windows,alerts}` (counts) | honest provenance note built from the counts, e.g. `` `Live Urbani chat (Amazon Bedrock Nova 2 Lite) — grounded server-side in ${N} recent log window(s) and ${M} alert(s).` ``. **Optional-chain + default (review Finding 6):** `N = Number(body.evidence?.log_windows) || 0`, `M = Number(body.evidence?.alerts) || 0`, so a 2xx answer that lacks the `evidence` object still renders (note reports `0 window(s) / 0 alert(s)`) instead of throwing on `evidence.log_windows` and becoming a false "unavailable". |

**Citations decision (locked):** `citations = []`. The `/chat` response returns only **counts** (`log_windows`, `alerts`), not the actual evidence lines, so the only truthful value for "the specific lines the answer relied on" is empty; the real grounding is conveyed by `meta.note`. Substituting locally-fetched log lines as the model's citations would overclaim. _Reviewer option:_ if a non-empty evidence panel is desired for the demo, attach the real `ERROR`/`WARN` lines from the live window that `chatService` already fetched (`input.logs`), capped at 5, **framed in the note as "related recent log lines," not as the model's citations** — still real, never invented. Default stays `[]` for maximum honesty.

### B.9.2 `chatService` changes — `packages/backend/src/services/chatService.ts`

- Default `service` → `config.urbani.service` (`main`); default `environment` → `config.urbani.environment` (`qa`). (Remove `'urbani-app'` / `'production-eb'`.)
- **Server-side service gating:** resolve `service = opts.service && config.urbani.services.includes(opts.service) ? opts.service : config.urbani.service`. Disabled/unknown services never reach the live endpoint (invariant §B.20).
- Keep the existing log-window fetch via `cloudwatch.getLogs({ service, limit: 100 })` (now LIVE latest+history) — it provides `logsSource` provenance and the MOCK-mode grounding; the live `/chat` grounds server-side regardless. The existing try/catch that degrades a failed fetch to an empty window + `WAITING_FOR_INTEGRATION` is retained.
- Call `aiProvider.askLogs({ question, logs: logsRes.value, service, environment, history })`.
- **Error path (no mock answer):** wrap the `askLogs` call in try/catch. On a thrown error (the live provider's `ServiceUnavailableError`, or any error), record a safe audit (`questionChars`, `logsSource`, `outcome: 'unavailable'` — no secrets) and **re-throw** so the Express error handler returns the controlled 503 (§B.15). In `INTEGRATION_MODE=mock` the provider is `MockAIProvider`, which never throws, so mock chat still returns a 200 MOCK answer (AC11).
- On success, persist usage/audit exactly as today (question length + `logsSource` only). The envelope `source = result.meta.source` (**answer** provenance, LIVE); `data.logsSource = logsRes.meta.source` (grounding provenance). `sourceNote = result.meta.note`.

### B.9.3 `AIProvider` contract — unchanged

No change to `AskLogsInput`/`AskLogsResult`/`AnalyzeTelemetry*`. (The prior draft's `incidentAnalyses` extension is **not** needed — chat grounds server-side via `/chat`.) `MockAIProvider` is untouched.

## B.10 Integration factory — `packages/backend/src/integrations/index.ts`

In `buildLive()` (gated on `config.urbani.logsConfigured`):
- `base.cloudwatch = new HttpUrbaniLogsAdapter(apiBaseUrl, apiKey, service, refreshMinutes, logsHistoryLimit, services, environment)`.
- `base.aiProvider = new HttpUrbaniChatProvider(apiBaseUrl, apiKey, service, chatModelId, chatTimeoutMs)` — **no `windowMinutes`**; it reads the per-request service from `input.service`.
- `base.urbaniAlerts = new HttpUrbaniAlertsAdapter(apiBaseUrl, apiKey, service, refreshMinutes, services, environment)`.
- Boot log: service **list** + refresh + model + history/alerts limits only — **never** the key (already the pattern). Update the existing message to reflect "chat via POST /chat (Nova 2 Lite)".
- `buildMock()` unchanged (`aiProvider` = `MockAIProvider`; `urbaniAlerts` undefined). `setIntegrationsForTesting` keeps working with the optional `urbaniAlerts` field. `getIntegrations()` caching unchanged.

## B.11 Alerts service — `packages/backend/src/services/alertService.ts`

Already ingests-on-read: `syncLiveAlerts()` pulls `urbaniAlerts.getLatest()` + `getHistory(alertsHistoryLimit)` and upserts via `alertRepository.upsertLivePreservingStatus` (acknowledge-preserving), labeling `source:'LIVE'` in live mode. With the adapter now fanning out across `main`+`payments`, both services' alerts ingest automatically. **No logic change** beyond inheriting the corrected adapter mapping + nullable confidence. Update the `LIVE_NOTE` wording to "Amazon Bedrock Nova 2 Lite". Confirm `list/get/acknowledge` keep working and that re-sync does not revert status (AC7).

## B.12 Services + roster — `telemetryService`, `ServiceSummary`, seed

QA exposes no `/services` endpoint, so the roster is **configuration-sourced** (authoritative client registry), while per-service health/error-rate have no live source and stay MOCK.

- **`ServiceSummary` (`packages/shared/src/domain.ts`)** — add the two fields as **OPTIONAL**: `enabled?: boolean` and `logGroup?: string` (plain interface; additive). **Decision (review iteration-2 Finding 4): optional + derived-at-read — NOT required, and NO schema migration.** `ServiceSummary` is also the declared return type of `serviceRepository.all()` / `serviceRepository.findById()` and of `telemetryService.service(id)` (singular, which returns `serviceRepository.findById(id)` directly), and the `mockServices` literals are typed `ServiceSummary[]`. Making the fields *required* would force the repository `mapService()` row mapping, `service(id)`, and every `mockServices` literal to supply them, breaking `tsc` (contradicting AC18) unless all of those sites are also updated. Declaring them optional leaves `mapService()` and the `mockServices` literals **unchanged** (they omit the fields), and the two values are populated at read time in the service layer (next bullet) where `config.urbani` is in scope. Rationale: QA exposes no `/services` endpoint, so the roster is config-authoritative — a raw SQLite row does not inherently know `enabled`/`logGroup`, and deriving them in the service layer is both the honest representation and the migration-free path.
- **Seed (`db/seed.ts`) + `mockData.ts`** — replace the EB roster (`urbani-core-api/worker/web`, `production-eb/staging-eb`) with the QA roster: `main` (enabled), `payments` (enabled), `auth` (disabled), `support` (disabled), all `environment: 'qa'`. Disabled services get `status:'UNKNOWN'`, `errorRate:0`, `alertCount:0`, `lastTelemetryAt:null`, `lastIncidentAt:null`.
- **`telemetryService.services()` AND `telemetryService.service(id)`** stay SQLite-backed / MOCK-labeled (no live source) but return the QA roster, **both** augmenting every returned row with `enabled` (membership in `config.urbani.services`) and `logGroup` (`config.urbani.logGroupFor(name)`) — `services()` via `.map(...)`, `service(id)` on the single row. Both call-sites must set the fields (not just `services()`) so the Services list and the service-detail endpoint stay consistent; `serviceRepository`/`mapService()` are not touched.
- **Frontend selectors** (Logs, Alerts, AI Insights, chat) list only `enabled` services; the **Services page** lists all four with an Enabled/Disabled indicator and the log-group column.

## B.13 AI Insights — `packages/frontend/src/pages/AIInsights.tsx`

- **New LIVE section** "Live incident analysis — Amazon Bedrock Nova 2 Lite": for each enabled service fetch `alertsApi.list({ service, pageSize: 1 })` (newest live alert) and render `summary`, `probableCause`, `recommendedActions`, `severity`, `anomalyType`, `modelId`, badged **LIVE**. Empty ⇒ honest "No current incident for `<service>`."
- Keep the existing advisory **Analyze** tool + analyses table, labeled **MOCK** (batch `POST /ai/analyze` has no QA endpoint). Fix stale defaults `service='urbani-core-api'`→`main`, `environment='production-eb'`→`qa`; the env `<Select>` offers `qa` only; the service `<Select>` lists enabled services.
- Update the subtitle: live analyses come from the real alerts pipeline (Bedrock Nova 2 Lite); the batch analyze remains seeded/MOCK.

## B.14 Chat UX — `useAssistantChat.tsx`, `AssistantPanel.tsx`, `AssistantMessage.tsx`, `AssistantWidget.tsx`

- `useAssistantChat` defaults: `service='main'`, `environment='qa'` (remove `urbani-app`/`production-eb`).
- **Truthful per-answer badge (AC16):** set the assistant message `source` to the envelope **answer** provenance `res.source` (not `res.data.logsSource`), so a MOCK or unavailable turn is never shown with a LIVE badge. Keep `meta = \`${provider} · ${modelId}\``; optionally append the grounding `sourceNote`.
- **Honest "unavailable" copy (FR5/AC10):** the existing `catch` already renders an `isError` bubble; change `API_ERROR_MESSAGE` to `'Urbani Copilot is temporarily unavailable. Please try again.'` so it is accurate for both a 503 from the chat route and a transport failure. No fake answer, no LIVE/MOCK badge on the error bubble.
- **Service selector in BOTH variants:** the page variant keeps its selector (now enabled services + env fixed to `qa`, dropping `staging-eb`); the floating `AssistantPanel` header gains a compact `<Select>` of enabled services (populated from `servicesApi.list()`, filtered to `enabled`) so users can scope `main`/`payments` from the widget. Remove the `urbani-app` placeholder option.
- Floating header copy `Powered by Amazon Bedrock (Nova Lite)` → `Powered by Amazon Bedrock (Nova 2 Lite)`.

### B.14.1 Markdown rendering (FR11/AC16) — new `packages/frontend/src/components/assistant/markdown.tsx`

A small, dependency-free, **XSS-safe** `renderMarkdown(md: string): ReactNode` used by `AssistantMessage` for **assistant, non-error** bubbles only (user + error bubbles stay plain text).

- Builds React elements only — **never** `dangerouslySetInnerHTML`; React escapes all text by default.
- Supported subset: fenced code blocks ```` ``` ````; ATX headings `#`..`####`; unordered lists (`-`/`*`/`+`); ordered lists (`1.`); blockquotes `>`; paragraphs with soft line breaks; inline **bold** (`**`), _italic_ (`*`/`_`), and `inline code` (`` ` ``).
- Links: `[text](url)` is rendered as an `<a rel="noopener noreferrer" target="_blank">` **only** when `url` starts with `http://` or `https://`; any other scheme (incl. `javascript:`) is rendered as literal text. (Prevents script-URL injection.)
- Deterministic and pure → unit-testable (see §B.22).

**Decision:** in-house renderer over adding `react-markdown`+`rehype-sanitize`, to honor NFR2 ("prefer no new npm deps"). _Reviewer option:_ swap in `react-markdown` + `remark-gfm` + `rehype-sanitize` if a battle-tested parser is preferred; the `AssistantMessage` call-site stays identical.

## B.15 Error taxonomy — `packages/backend/src/lib/errors.ts`

Add a controlled, non-500 error for the chat-unavailable case:

```ts
/** 503 — a live integration is reachable-but-failing right now (transient). */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super('CHAT_UNAVAILABLE', message, 503);
  }
}
```

The existing `errorHandler` already maps any `AppError` to `res.status(err.statusCode)` with the safe `{ error: { code, message, correlationId } }` body (no stack, no key), and logs 5xx server-side. A 503 is a **controlled** response, not a 500 crash (AC10). (Code name `CHAT_UNAVAILABLE` is chat-specific and clear; the class is reusable if other live sources ever need the same semantics.)

## B.16 Settings — `settingsService.ts` + `SettingsView` + `Settings.tsx`

- `runtimeIntegrationState` already returns `{mode:'LIVE', status:'CONNECTED'}` for `CLOUDWATCH`/`URBANI_APP`/`BEDROCK`/`DYNAMODB` in live mode — **keep** (AC14).
- **Extend `SettingsView`** (`settingsService.ts` + mirrored type in `api/endpoints.ts`):
  - `cloudwatch.logGroups: string[]` (from `config.urbani.logGroups`) in addition to the single `logGroup` (kept for back-compat; show the list).
  - `ai.guardrailName: string`, `ai.guardrailVersion: string` (from `config.bedrock.guardrailName/Version`).
  - `pipeline: typeof URBANI_QA_PIPELINE` — region, flow, collector lambda + EventBridge rule + 5-min schedule, alert writer + 30-min dedup, logs/alerts/chat API lambdas, and the enabled/disabled roster.
- **`Settings.tsx`:** CloudWatch card shows **both** ECS log groups; AI card shows Nova 2 Lite + guardrail id **and** name + version; a new "AWS Observability Pipeline (QA)" card renders `pipeline` (region, flow, lambdas, schedule, dedup, roster). The integrations table already reflects runtime LIVE/CONNECTED.

## B.17 Seed + mock data — `db/seed.ts`, `mockData.ts`

- **Integration rows (`seed.ts`):** rename `int-urbani-app` display `Urbani Application (Elastic Beanstalk)` → `Urbani QA ECS services (main, payments)`; `BEDROCK` → `Amazon Bedrock — Nova 2 Lite`; `DYNAMODB` → `AI incident alerts (/alerts API ← DynamoDB)`; `CLOUDWATCH` → `CloudWatch Logs (ECS: main, payments)`. Seeded `mode/status` stay `MOCK/WAITING_FOR_INTEGRATION` (the runtime reconciler overrides to LIVE/CONNECTED in live mode; AC8/AC14).
- **`mockData.ts`:** `mockServices` → QA roster (B.12), `environment:'qa'`. `mockAlerts` → reference `main`/`payments`, `environment:'qa'`, `modelId: 'global.amazon.nova-2-lite-v1:0'` (keep numeric confidence). `mockLogs`/`mockMetrics` → reference `main`/`payments` + `qa`. `mockUsage.modelId` → Nova 2 Lite label. `MOCK_NOTE` unchanged.

## B.18 Env + Docker (remove old live things)

Secret hygiene: the real `URBANI_API_KEY` lives only in gitignored `.env` files; it is never printed here, logged, echoed, committed, or returned.

- **`packages/backend/.env` (bare-metal source; already resolves to QA via last-wins):** de-duplicate so each key appears once with its QA value. Specifically: set `CLOUDWATCH_LOG_GROUP=/aws/ecs/urbaniqa-qa-main/app` (currently still EB in the top block); set `BEDROCK_FALLBACK_MODEL_ID=global.amazon.nova-2-lite-v1:0` and `BEDROCK_GUARDRAIL_ID=0z947gmtk58a` (top block is stale, bottom block only overrides some keys); add `URBANI_ENVIRONMENT=qa`, `URBANI_LOGS_HISTORY_LIMIT=20`, `URBANI_CHAT_TIMEOUT_MS=30000`, `URBANI_ALERTS_HISTORY_LIMIT=5`, `BEDROCK_GUARDRAIL_NAME=UrbaniQaObservabilityGuardrail`, `BEDROCK_GUARDRAIL_VERSION=1`; **remove** `URBANI_LOGS_WINDOW_MINUTES`. Keep `INTEGRATION_MODE=live`, `URBANI_SERVICES=main,payments`, `URBANI_SERVICE=main`, and the QA base URL + key (unchanged values).
- **Root `.env` (Docker interpolation source; currently points dev at the OLD account):** replace the bottom "Local Urbani API integration" block (`830oi1gxng…ap-south-1…/prod`, `URBANI_SERVICE=urbani-app`, old key) with the **QA** values: QA base URL, QA key, `URBANI_SERVICE=main`, `URBANI_SERVICES=main,payments`, `URBANI_ENVIRONMENT=qa`, `URBANI_REFRESH_MINUTES=5`, `URBANI_LOGS_HISTORY_LIMIT=20`, `URBANI_CHAT_MODEL_ID`/`BEDROCK_PRIMARY_MODEL_ID` Nova 2 Lite, `BEDROCK_GUARDRAIL_ID=0z947gmtk58a`, guardrail name/version, `URBANI_CHAT_TIMEOUT_MS=30000`, `URBANI_ALERTS_HISTORY_LIMIT=5`, `AWS_REGION=us-east-1`; set `CLOUDWATCH_LOG_GROUP=/aws/ecs/urbaniqa-qa-main/app`. Keep `INTEGRATION_MODE=live`. This makes bare-metal and Docker consistent (AC19).
- **`.env.example` (NO secret values):** mirror the QA key set — `URBANI_SERVICE=main`, `URBANI_SERVICES=main,payments`, `URBANI_ENVIRONMENT=qa`, `URBANI_LOGS_HISTORY_LIMIT=20` (remove `URBANI_LOGS_WINDOW_MINUTES`), `URBANI_CHAT_MODEL_ID=global.amazon.nova-2-lite-v1:0`, `URBANI_CHAT_TIMEOUT_MS=30000`, `URBANI_ALERTS_HISTORY_LIMIT=5`; `CLOUDWATCH_LOG_GROUP=/aws/ecs/urbaniqa-qa-main/app` (note the payments group `/aws/ecs/urbaniqa-qa-payments/app` in a comment); `BEDROCK_PRIMARY_MODEL_ID`/`BEDROCK_FALLBACK_MODEL_ID`/`BEDROCK_GUARDRAIL_ID`/`BEDROCK_GUARDRAIL_NAME`/`BEDROCK_GUARDRAIL_VERSION` QA values; `AWS_REGION=us-east-1`. **Rewrite** the Urbani section comment: chat **IS** live via `POST {base}/chat` (Bedrock Nova 2 Lite); logs/alerts read latest+history per service; list the full endpoint set (logs/alerts latest+history per service + chat); QA / ECS / us-east-1. **Remove** the `apac.amazon.nova-lite` references and any "no live chat / mock fallback" wording. Keep `URBANI_API_BASE_URL=`/`URBANI_API_KEY=` blank with "inject at deploy time".
- **`docker-compose.yml`:** pass through the new keys so Docker matches bare-metal — `URBANI_SERVICES`, `URBANI_SERVICE` (default `main`, was `urbani-app`), `URBANI_ENVIRONMENT` (default `qa`), `URBANI_REFRESH_MINUTES`, `URBANI_LOGS_HISTORY_LIMIT`, `URBANI_CHAT_MODEL_ID`, `URBANI_CHAT_TIMEOUT_MS`, `URBANI_ALERTS_HISTORY_LIMIT`, `CLOUDWATCH_LOG_GROUP` (default `/aws/ecs/urbaniqa-qa-main/app`), `BEDROCK_PRIMARY_MODEL_ID` (default Nova 2 Lite), `BEDROCK_FALLBACK_MODEL_ID`, `BEDROCK_GUARDRAIL_ID` (default `0z947gmtk58a`), `BEDROCK_GUARDRAIL_NAME`, `BEDROCK_GUARDRAIL_VERSION`, `AWS_REGION`. Adding `CLOUDWATCH_LOG_GROUP: ${CLOUDWATCH_LOG_GROUP:-/aws/ecs/urbaniqa-qa-main/app}` removes the bare-metal/Docker asymmetry the bare-metal `.env` sets but compose previously omitted (review Finding 7); it is display-adjacent only, since Settings surfaces the derived `config.urbani.logGroups` list. Secrets (`URBANI_API_KEY`, `JWT_SECRET`) stay interpolated from `.env`, never inlined.

## B.19 Error handling (per operation)

| Operation | Failure | Recoverable? | Caller receives | Logging |
|---|---|---|---|---|
| `GET /logs/latest\|history` per service | network/timeout/non-200 | yes | stale cache for that service, else `[]`; other services unaffected | `warn` (service + message, no key) |
| `telemetryService.logs()` | adapter degraded | yes | `source:'LIVE'`, `items:[]` (never 500) | — |
| `GET /alerts/latest\|history` per service | network/timeout/non-200 | yes | stale cache else `[]` | `warn` (no key) |
| `alertService.syncLiveAlerts()` | adapter throws | yes | swallowed; serve previously-stored alerts | `warn` |
| malformed alert object | schema `safeParse` fail | yes | entry skipped | `warn` (alertId + failing paths) |
| `chatService` log-window fetch | throws | yes | empty window, `logsSource:'WAITING_FOR_INTEGRATION'`; chat proceeds (live `/chat` grounds server-side) | `warn` |
| `HttpUrbaniChatProvider.askLogs` (LIVE) | non-2xx / network / timeout / abort | yes | **throws `ServiceUnavailableError`** → controlled **HTTP 503** `{code:'CHAT_UNAVAILABLE'}`; **no mock answer** | `warn`→handler logs 5xx; key never echoed |
| `MockAIProvider.askLogs` (MOCK mode) | n/a (deterministic) | — | 200 MOCK answer | — |
| expired/rotated key (403 everywhere) | all live calls fail | yes | logs `[]`, alerts `[]`/stale, chat 503 "unavailable" — no page 500 | `warn`, key never echoed |

No `IntegrationError` is thrown out of the **logs** adapter anymore (it degrades). The **chat** provider intentionally throws a 503-mapped error (not a mock answer).

## B.20 Validation (external inputs)

- **QA responses** (untrusted): every field is defensively coerced (string/number/ISO), level inferred, severity enum-clamped, confidence `null`, chat counts `Number(...)||0`; alerts validated against `urbaniIncidentAlertSchema` (malformed skipped). Unknown JSON shapes never crash mapping. The markdown answer is treated as untrusted and rendered via the escaping renderer (§B.14.1).
- **`POST /api/chat` body** (`chatSchema`): `question` is `z.string().trim().min(1).max(1000)` — the added `.trim()` (review Finding 8) is the **only** schema change and ensures a whitespace-only question is rejected with 400 **before** a Bedrock `/chat` call is billed (the frontend already trims; this makes the server contract match). `service`/`environment` optional strings; `history` ≤20 turns, content ≤4000. On failure → 400 via the existing zod handler. The resolved `service` is intersected with the enabled-service list server-side (unknown/disabled → default `main`), so disabled/unknown services are never POSTed to `/chat`.
- **`GET /api/logs` / `/api/alerts` query** (`logQuerySchema`/`alertQuerySchema`, unchanged): `level`/`severity`/`status` enum-validated; `service` free string, filtered in-service against the fetched window/roster (only enabled services are fetched live).
- **Env** (`config` zod): invalid types fail fast at boot with a clear message (existing behavior). Secrets have no usable production defaults.

## B.21 Invariants + ownership

- **Secret never leaves the server** — owned by the adapters/config/provider (key only in `fetch` headers; never in meta/answer/sourceNote/throws/logs). Verified by unit tests asserting `JSON.stringify(result)` excludes the key, and that a 403 path throws/degrades without the key in the message.
- **Honest provenance** — owned by the service layer (`meta.source` / `Sourced.source`) and provider mapping (LIVE for a real `/chat` answer; MOCK only in mock mode; 503 for a failed live chat). The frontend only renders the server's label and uses `res.source` for the answer badge; it never upgrades MOCK→LIVE.
- **No fabrication** — owned by the adapters/provider: `evidence` defaults `[]`, confidence `null`, chat `citations:[]`; empty windows produce honest empty results; a failed live chat yields an honest "unavailable", not a composed answer.
- **Chat uses the selected, enabled service** — owned by `chatService` (service intersection) + the provider (sends `input.service`).
- **Acknowledge survives re-sync** — owned by `alertRepository.upsertLivePreservingStatus`.
- **Disabled services are never called** — owned by `config.urbani.services` (only enabled services reach the adapters) + the `chatService` service intersection.
- **Single chat route** — owned by `routes/apiRoutes.ts` (`POST /chat` → `chatService.ask`); no second chat API; frontend `chatApi.ask` → `/chat`.

## B.22 Testability

**Unit (vitest, mocked `fetch`):**
- `HttpUrbaniLogsAdapter.test.ts` — **rewrite** to QA shapes: `main`/`payments`, flat `{timestamp, message}` with inferred level; `/logs/history` `windows[]` flatten + merge with `/logs/latest` + dedup; newest-first ordering with the **unparseable-timestamp-sorts-last** rule (replaces the old `plain string line` expectation — fixes failing test #2); **graceful `[]` on 403** with `source:'LIVE'` (replaces the old reject-on-403 expectation — fixes failing test #1); x-api-key sent; key never in `JSON.stringify`.
- `HttpUrbaniChatProvider.test.ts` — **rewrite** to the LIVE `/chat` reality: (a) 200 maps `answer`(markdown) through, `citations:[]`, `modelId` from `model_id` (snake_case) else Nova 2 Lite label, `meta.source:'LIVE'`, note names the `{log_windows,alerts}` counts; (b) request body is **exactly** `{service, question}` (no `minutes`) and uses `input.service` (assert `payments` is sent when `input.service='payments'`); x-api-key sent; key never in `JSON.stringify`; (c) **non-2xx (403) → throws `ServiceUnavailableError`** (NOT a mock fallback), message contains no key; (d) network reject / abort → throws `ServiceUnavailableError`; (e) `analyzeTelemetry` still delegates to Mock (`provider:'MockAIProvider'`, `meta.source:'MOCK'`, null alert on no evidence). **Delete** the old `minutes` tests and the two "falls back to the Mock provider" tests (behavior inverted).
- `HttpUrbaniAlertsAdapter.test.ts` — **rewrite** to flat snake_case: `/alerts/latest` top-level gated on `alert_id` (no `alert_id` → `[]`); `/alerts/history` `alerts[]`; `recommendation`(string) → `recommendedActions:[recommendation]`; `evidence:[]`; `confidence:null`; `modelId` Nova 2 Lite; severity default `MEDIUM`; non-200 → `[]`; x-api-key sent; key never leaked.
- `integrations/index.test.ts` — keep the existing mock-mode assertions (they pass because `src/test/setup.ts` sets `INTEGRATION_MODE=mock` **before** `../config` is imported). **Add the live-mode factory assertion via a fresh-config dynamic import (review iteration-2 Finding 2), NOT via `process.env` mutation + `resetIntegrations()`:** `config` is `export const config = {…}` built **once** at import from a `process.env` snapshot, and `resetIntegrations()` only clears the cached `Integrations` object — it does not re-read env — so mutating `process.env.INTEGRATION_MODE='live'` mid-test leaves `config.integrationMode==='mock'` and `getIntegrations()` still runs `buildMock()` (the assertion `aiProvider.name==='HttpUrbaniChatProvider'` would fail). Instead, in an isolated test: snapshot `process.env`; set `INTEGRATION_MODE='live'`, `URBANI_API_BASE_URL='https://example.test/qa'`, `URBANI_API_KEY='test-key'` (dummy values — no real key, and no network call occurs at construction); `vi.resetModules()`; `const { getIntegrations } = await import('./index')` (re-imports `../config` fresh against the new env; `dotenv/config` does not override already-set keys, so the dummy values win over `packages/backend/.env`'s live creds); assert `aiProvider.name==='HttpUrbaniChatProvider'`, `cloudwatch instanceof HttpUrbaniLogsAdapter`, and `urbaniAlerts` is defined; then restore the env snapshot and `vi.resetModules()` in a `finally`. The file's static top-level `getIntegrations`/`resetIntegrations` imports keep binding to the original mock config, so the mock-mode tests are unaffected. _Fallback if `resetModules` proves flaky:_ assert the live wiring by constructing `HttpUrbaniChatProvider` / `HttpUrbaniLogsAdapter` / `HttpUrbaniAlertsAdapter` directly (as the adapter tests already do) and checking their `name`/`instanceof` — this skips the config gate entirely.
- `alertService.test.ts` — keep the existing mock-mode tests, with the `sampleAlert` fixture updated to QA values (§B.23). **Acknowledge-survives-resync (AC7) is proven at the REPOSITORY level, not through the config-gated service (review iteration-2 Finding 2):** `syncLiveAlerts()` early-returns on `!liveConfigured()`, and `liveConfigured() = config.integrationMode==='live' && config.urbani.logsConfigured` reads the same frozen `mock` singleton, so a fake `urbaniAlerts` injected via `setIntegrationsForTesting` would never be queried. Instead, using the existing `freshTestDb()` harness, drive `alertRepository` directly: `upsertLivePreservingStatus(alert)` (new row ⇒ `OPEN`) → `acknowledge(alertId, actor)` → `upsertLivePreservingStatus(sameAlert)` again, then assert `findById(alertId)!.status==='ACKNOWLEDGED'` and `acknowledgedBy`/`acknowledgedAt` are preserved. No config gate applies at the repository layer, so this deterministically proves the re-sync invariant.
- New `shared` test: `urbaniIncidentAlertSchema` accepts `confidence: null` and still rejects out-of-range numbers.
- New frontend `markdown.test.ts(x)` — asserts bold/italic/code/list/heading/fenced-code render, and that a `javascript:` link is rendered as literal text (no anchor).

**Integration-level (manual/dev run, implementer's verification step):** boot with QA env; confirm the boot log names the service list (not the key); `GET /api/logs|/api/alerts` return LIVE for both services; `POST /api/chat` for `main` and `payments` each make exactly one `/chat` call with the correct `service`, return LIVE Nova 2 Lite markdown, and never a mock phrasing; a forced bad key yields a 503 "unavailable" chat (no mock answer, no 500) while logs/alerts degrade to empty/stale; the key is absent from all responses, logs, and the frontend bundle.

Design note on testability: the logs/alerts adapters and the chat provider are thin, deterministic mappers over `fetch`, so they unit-test cleanly with a stubbed global `fetch`. The chat 503 path is observable as a thrown typed error (easy to assert) and, end-to-end, as an HTTP 503 with a safe body.

## B.23 File-by-file change inventory

**Backend**
- `src/config/index.ts` — new/changed keys (B.4): add `urbani.environment`, `urbani.logsHistoryLimit`, `urbani.logGroupFor`/`logGroups`, `bedrock.guardrailName`/`guardrailVersion`; retire `logsWindowMinutes`; QA defaults; chat timeout 30s.
- `src/config/urbaniQa.ts` — **new** non-secret pipeline facts (B.5).
- `src/integrations/live/HttpUrbaniLogsAdapter.ts` — latest+history flatten/merge/dedup, level inference, ordering fix, graceful-`[]` (never throw), services list + environment, retire minutes (B.6).
- `src/integrations/live/HttpUrbaniAlertsAdapter.ts` — flat snake_case remap, latest gated on `alert_id`, `recommendation`→single-element array, nullable confidence, Nova 2 Lite modelId, services list + environment (B.7).
- `src/integrations/live/HttpUrbaniChatProvider.ts` — send `input.service`, correct response mapping (`model_id`, counts→note, markdown, `citations:[]`), 30s timeout, **remove mock answer fallback** (throw `ServiceUnavailableError`); keep internal Mock only for `analyzeTelemetry` (B.9).
- `src/integrations/index.ts` — construct the three live sources with services + environment + limits; chat provider without `windowMinutes`; boot log copy (B.10).
- `src/services/chatService.ts` — QA defaults, service intersection, send selected service, 503 on live failure (no mock answer), answer-provenance envelope (B.9.2).
- `src/routes/apiRoutes.ts` — `chatSchema.question` gains `.trim()` so whitespace-only questions 400 before a billed `/chat` call (B.20 / review Finding 8). No other route change.
- `src/services/alertService.ts` — LIVE_NOTE copy only; inherits corrected adapter + nullable confidence (B.11).
- `src/services/telemetryService.ts` — **both** `services()` and `service(id)` augment the returned roster row(s) with the optional `enabled` + `logGroup` (derived-at-read; repository untouched) (B.12).
- `src/services/settingsService.ts` + `SettingsView` — log groups, guardrail name/version, pipeline block (B.16).
- `src/repositories/alertRepository.ts` — `rowToAlert` passes `null` confidence (B.8).
- `src/lib/errors.ts` — add `ServiceUnavailableError` (503, `CHAT_UNAVAILABLE`) (B.15).
- `src/db/seed.ts` + `src/integrations/mock/mockData.ts` — QA roster, integration display names, Nova 2 Lite labels, `qa` env (B.17).
- `src/db/migrations/001_initial_schema.sql` — **comment-only** edits for AC17 grep-clean (review Finding 1): `-- e.g. production-eb, staging-eb` → `-- e.g. qa`; `-- e.g. urbani-core-api` → `-- e.g. main, payments`. Safe: `db/migrate.ts` keys applied migrations by **filename** (not a content checksum) and SQL comments are inert, so this changes neither the applied schema nor already-migrated databases (a fresh DB runs identical DDL). No `002_*` migration is introduced.
- `src/integrations/ai/MockAIProvider.test.ts` — rewrite fixtures off the EB roster: `service: 'urbani-core-api'`/`'urbani-web'` → `'main'`/`'payments'`; `environment: 'production-eb'`/`'staging-eb'` → `'qa'`; the model literals (top-level `MODEL = 'anthropic.claude-3-5-sonnet…'` and the inline `new MockAIProvider('amazon.nova-lite-v1:0')`) → `'global.amazon.nova-2-lite-v1:0'`. **The swaps are NOT all assertion-neutral (review iteration-2 Finding 1):** the *"produces an evidence-based finding…"* test asserts `res.alert!.severity==='CRITICAL'`, but `MockAIProvider.severityFor()` returns `CRITICAL` only when `anomalyType==='DatabaseConnectionTimeout' && input.environment.includes('production')` — with `environment:'qa'` the 3 ERROR lines fall through to `HIGH`. **Chosen handling:** change that test's primary (QA) assertion to `expect(res.alert!.severity).toBe('HIGH')` and update the `// CRITICAL because…` comment to note QA is not a production environment. To keep the CRITICAL escalation branch covered **without** reintroducing a forbidden token, add one explicit assertion in the same test that re-runs the identical 3-error `DatabaseConnectionTimeout` input with a bare `environment: 'production'` (bare `production` is **not** in the AC17 forbidden set — only `production-eb`/`staging-eb` are — so this stays grep-clean) and asserts `severity==='CRITICAL'`. The other three tests (null-alert grounding, configured-model-id echo, determinism) remain assertion-neutral under the fixture swap. The earlier "leave behavior and assertions unchanged" claim is **withdrawn**. (`severityFor()` production logic is left unchanged — a mock-only heuristic; changing it has wider blast radius than updating the one assertion.)
- `src/services/alertService.test.ts` — **(self-found inventory gap; §B.28)** its `sampleAlert` fixture uses `service:'urbani-core-api'` + `environment:'production-eb'` (forbidden under AC17) and `modelId:'anthropic.claude-3-5-sonnet…'`. Rewrite to QA: `service:'main'`, `environment:'qa'`, `modelId:'global.amazon.nova-2-lite-v1:0'`. Behavior-neutral — `severity:'CRITICAL'` is a literal on the fixture (not computed), and the tests assert MOCK provenance, pagination/total, severity-filter counts, evidence/action counts, NotFound, and acknowledge, none of which depend on the service/environment/model values. Add the repository-level acknowledge-survives-resync test here (§B.22) since the `freshTestDb()` harness and `alertRepository` import already exist in this file.
- Tests — rewrite logs/alerts/chat adapter tests; update `MockAIProvider.test.ts` fixtures + severity assertion and `alertService.test.ts` fixtures (above); add the factory live-mode (dynamic-import), repository-level acknowledge-survives-resync, and shared nullable-confidence tests (B.22).

**Shared**
- `packages/shared/src/alerts.ts` — nullable `confidence` (B.8).
- `packages/shared/src/domain.ts` — `ServiceSummary.enabled?` + `.logGroup?` (OPTIONAL — avoids a tsc ripple to the repository mapping, `service(id)`, and the `mockServices` literals; B.12).

**Frontend**
- `components/assistant/useAssistantChat.tsx` — defaults `main`/`qa`; message badge = `res.source`; honest "temporarily unavailable" copy (B.14).
- `components/assistant/AssistantPanel.tsx` — service selector in both variants (enabled services), env `qa`, Nova 2 Lite copy (B.14).
- `components/assistant/AssistantMessage.tsx` — render markdown for assistant answers (B.14 / B.14.1).
- `components/assistant/markdown.tsx` — **new** safe markdown renderer (B.14.1).
- `api/endpoints.ts` — mirror the extended `SettingsView` (log groups, guardrail name/version, pipeline) (B.16).
- `pages/AIInsights.tsx` — LIVE analyses section + QA defaults/selectors (B.13).
- `pages/Services.tsx` — enabled/disabled indicator + log-group column (B.12).
- `pages/Settings.tsx` — both log groups, guardrail name/version, pipeline card (B.16).
- `pages/Logs.tsx`, `pages/Alerts.tsx` — enabled-service selectors; QA subtitles; confidence `—` for live alerts (already supported) (B.15 copy).
- `pages/Dashboard.tsx` — banner model name → Nova 2 Lite; keep "metrics/services/usage/audit seeded".

**Env/infra**
- `packages/backend/.env`, root `.env`, `.env.example`, `docker-compose.yml` — QA values, new keys, remove old-account wiring; secrets only in gitignored `.env` (B.18).

**Docs (copy-only, non-blocking):** `README.md`, `docs/PHASE3_URBANI_LOGS_INTEGRATION.md`, `docs/AWS_DEPLOYMENT_GUIDE.md` describe the old single-service/EB/`apac.nova-lite`/`?minutes=N` reality; update where cheap. They do not gate the build. Per AC17, `docs/`, `.agents/` (this design, the review, `_logs2.txt`), and the `OUTPUT/` sales deck/diagram are **excluded** from the grep-clean gate — they are narrative/historical artifacts that legitimately quote the old values.

## B.24 Edge cases

- `payments` idle: `/logs/latest` `log_count:0` → history supplies older windows; if both empty, Logs shows "No log entries" and chat still answers via the live `/chat` (server-side grounding), or an honest 503 if `/chat` itself fails.
- `/alerts/latest` with no `alert_id` → `[]` (no current alert), while `/alerts/history` may still list past alerts.
- `recommendation` empty/whitespace → `recommendedActions: []`.
- Unparseable log timestamp → sort key `-Infinity` (sorts last); display falls back to `window_end`/now.
- Duplicate entries across latest ∪ history → de-duped on `service|timestampMs|message`; same `alertId` across `/latest`+`/history` → de-duped by `alertId` before ingest (existing).
- Chat for a disabled/unknown service → intersected to the default `main` server-side; never POSTs a disabled service.
- Live `/chat` 403 (expired/rotated key) or timeout → 503 "temporarily unavailable" (no mock answer, no 500); logs/alerts degrade to empty/stale. Key never echoed.
- `INTEGRATION_MODE=mock` (no creds) → chat returns a MOCK answer; alerts/logs return MOCK — a coherent creds-free demo.
- MEDIUM-only severities today → full LOW/MEDIUM/HIGH/CRITICAL mapping retained; unknown → MEDIUM.
- Markdown answer containing a `javascript:`/`data:` link or raw HTML → rendered as inert escaped text (no anchor, no HTML injection).

## B.25 Reviewer notes / open items

- **Live chat via `POST /chat` with no mock fallback (B.9/B.15)** is the central correction over the prior draft. The failure mode is a controlled **HTTP 503** `CHAT_UNAVAILABLE` surfaced as an honest "temporarily unavailable" chat bubble — no fabricated/mock answer, no key, no 500. _Alternative considered:_ return a `200` with a dedicated provenance value (e.g. a new `DATA_SOURCES` member `UNAVAILABLE`); rejected to avoid rippling a new enum through the shared contract and `SourceBadge`/CSS, and because the existing `isError` UI already renders an honest failure. If the reviewer prefers a 200 state, the change is localized to `chatService` (return instead of throw) + one `DATA_SOURCES` value + one CSS class.
- **Chat `citations:[]` (B.9.1)** is the honest mapping of the counts-only `/chat` evidence; the grounding counts live in `meta.note`. Showing locally-fetched log lines as the model's citations would overclaim. Reviewer may opt into "related recent log lines" (real, capped, clearly framed) if a populated evidence panel is desired for the demo.
- **Nullable confidence (B.8)** is a shared-contract change chosen over a fabricated numeric default to honor honest provenance; the UI already renders `null → —`.
- **In-house markdown renderer (B.14.1)** honors NFR2; `react-markdown`+`rehype-sanitize` is the drop-in alternative if preferred.
- **Services roster derive-at-read (B.12)** avoids a schema migration; if the reviewer wants persisted `enabled`/`log_group` columns, add migration `002_*` and seed them — behavior is identical.
- **DynamoDB integration shown LIVE/CONNECTED** reflects that alerts genuinely originate from the upstream DynamoDB-backed `/alerts` API (via `UrbaniAlertsApiFn`), even though the app persists to SQLite; the display name clarifies this.

## B.26 Corrections vs the prior stale design (loop-back log)

This document **overwrites** a prior draft. It has now been through **two** design-review iterations: **iteration 1** (`CHANGES_REQUESTED`: 3 MEDIUM + 5 NIT) — point-by-point responses in **§B.27**; and **iteration 2** (`qa-live-design-review.json` / `qa-live-design-review.md`, verdict `CHANGES_REQUESTED`: 2 MEDIUM + 2 NIT, all confined to the test plan) — point-by-point responses in **§B.28**. The authoritative task correction that invalidated the prior draft's chat approach is resolved as follows:

1. **Prior: "no live `/chat`; compose chat from `/alerts`+`/logs`; new `UrbaniGroundedChatProvider`; `MockAIProvider` as free-form fallback."** → **Addressed/overwritten.** `POST /chat` **is live and working** for both services. We **keep `HttpUrbaniChatProvider`** POSTing `/chat`, fix its response mapping, make it send the **selected** service, and **remove the mock answer fallback** (honest 503 on failure). No `UrbaniGroundedChatProvider`; no `AskLogsInput.incidentAnalyses` extension; `AIProvider` contract unchanged.
2. **Prior: chat failure fell back to a deterministic mock answer.** → **Addressed.** In live mode, failure is an honest "temporarily unavailable" 503; `MockAIProvider` answers only in `INTEGRATION_MODE=mock`.
3. **Prior: `POST /chat` 403 "route does not exist".** → **Corrected** to the verified 200 shape in §B.3 (`answer` markdown, `evidence` counts, `model_id` snake_case).
4. **Prior: delete `HttpUrbaniChatProvider.ts` + its test.** → **Changed** to *keep and fix* the provider; the test is *rewritten* (not deleted) to the live shape, including inverting the fallback expectation to "throws".
5. **Multi-service chat bug found during review of the real code:** the provider sent its constructor's fixed `service`, so `payments` chat would have queried `main`. → **Fixed** (sends `input.service`; AC8/AC9).
6. **Carried forward unchanged (still correct):** logs latest+history flatten/merge/dedup + ordering/degradation fixes (fixes the 2 failing tests), flat snake_case alerts remap, nullable confidence, multi-service fan-out, Settings/AI-Insights live surfaces, and the full "remove old live things" env/seed/mock/UI sweep.

## B.27 Responses to design-review findings (iteration 1)

Reviewer verdict: **CHANGES_REQUESTED** — 3 MEDIUM, 5 NIT (`qa-live-design-review.json` / `…-review.md`). Every finding is **addressed** in this revision (none backlogged, none ignored); all choices stay inside the original requirements (both services, live `/chat` with no mock answer in live mode, flat snake_case alerts, secret hygiene, no new deps, suite-green, old-wiring removed). The reviewer also verified every claim this design makes about the *current* code (and the 2 failing logs tests) as accurate — no "wrong assumption" was raised, so nothing there needed correcting.

1. **[MEDIUM] Old-wiring inventory (B.23) + AC17 grep gate incomplete.** **Addressed.** Added `src/db/migrations/001_initial_schema.sql` (comment-only; safe because `db/migrate.ts` keys migrations by filename, not checksum, and comments are inert) and `src/integrations/ai/MockAIProvider.test.ts` (EB-roster fixtures → `main`/`payments`/`qa` + Nova 2 Lite literal) to the §B.23 inventory. Rewrote **AC17** to scope the grep to `packages/**/*.{ts,tsx,sql}` + the three env files + `docker-compose.yml`, excluding `.agents/`, `docs/`, and `OUTPUT/`, so the gate is meetable. Also added `urbani-core-api` and `elasticbeanstalk` to the forbidden set.
2. **[MEDIUM] Chat `resolveService` inconsistent (B.9/B.10/B.21), risked rewriting `payments`→`main`.** **Addressed.** §B.9 now defines `resolveService(s) = (typeof s === 'string' && s.trim()) ? s : this.service` — **presence-only**, no enablement check in the provider, no services list in its constructor (§B.10 already takes none). Enablement stays owned by `chatService` (§B.9.2) + `config.urbani.services`; §B.21's invariant wording is aligned ("sends `input.service` verbatim when present; never rewrites to the default"). Protects AC9.
3. **[MEDIUM] Central `/chat` mapping (B.9.1) rested on an unverified shape.** **Addressed.** Added gating pre-step **§B.0** requiring a real `POST /chat` (main + payments), `GET /logs/history`, and `GET /alerts/latest` capture, with field-name reconciliation **before** any mapper edit (key read from env, never printed/committed). Hardened §B.9.1: the `answer` field is resolved against the pinned name + defensive aliases, and a 2xx body with **no** recognizable answer field now **throws `ServiceUnavailableError`** (honest 503) instead of emitting a canned string under a LIVE badge — so a shape miss fails loudly, not silently.
4. **[NIT] Log sort-key under-specified vs. display timestamp (AC4 regression risk).** **Addressed.** §B.6 now specifies `mapLogs` emitting `{ entry, sortKeyMs }` tuples with `sortKeyMs = parsedEntryMs ?? enclosingWindowEndMs ?? -Infinity`, a stable descending sort on `sortKeyMs`, and a final `.map(t => t.entry)`; the human-facing `timestamp` keeps its own separate `window_end`/`now()` display fallback. Unresolved timestamps sort last.
5. **[NIT] `LogEntry.id` referenced an undefined `hash()`.** **Addressed.** §B.6.2 now defines `id = \`${service}:${sortKeyMs}:${sha1(\`${service}|${sortKeyMs}|${message}\`).slice(0,12)}\`` using `crypto.createHash` (already imported for `randomUUID`); the hash input is the same natural key as dedup, so id/dedup stay consistent and deterministic.
6. **[NIT] `/chat` success mapping could throw on a missing `evidence` object.** **Addressed.** §B.9.1's note now uses `Number(body.evidence?.log_windows) || 0` and `Number(body.evidence?.alerts) || 0`, so a 2xx answer lacking `evidence` renders (note reports `0/0`) instead of becoming a false "unavailable".
7. **[NIT] `docker-compose.yml` omitted `CLOUDWATCH_LOG_GROUP`.** **Addressed.** §B.18 adds `CLOUDWATCH_LOG_GROUP: ${CLOUDWATCH_LOG_GROUP:-/aws/ecs/urbaniqa-qa-main/app}` to the compose passthrough, removing the bare-metal/Docker asymmetry.
8. **[NIT] `chatSchema.question` accepted whitespace-only input.** **Addressed.** §B.20 changes the schema to `z.string().trim().min(1).max(1000)` so blank questions 400 before a billed `/chat` call; `apiRoutes.ts` added to the §B.23 inventory.

**Unverified external shapes (reviewer's logged risk), now mitigated by §B.0:** the `/chat` body (`answer`, `model_id`, `evidence:{log_windows,alerts}`) and `/logs/history` structure are pinned by the gating probe before coding; the mappers remain defensive (aliases, optional-chaining, flat-`logs[]` fallback, schema `safeParse` skip) so a surprise degrades honestly rather than crashing or fabricating.

## B.28 Responses to design-review findings (iteration 2)

Reviewer verdict: **CHANGES_REQUESTED** — 2 MEDIUM, 2 NIT (`qa-live-design-review.json` / `…-review.md`). The reviewer confirmed the design honors every non-negotiable task fact and that nearly every claim it makes about the *current* code is accurate (and that the canonical `npm run test` shows exactly the 2 known-failing logs tests); the blocking issues were **confined to the test plan**, which as written would have left the suite red (missing NFR4/AC18 "full suite green"). Every finding is **addressed** below (none backlogged, none ignored); all choices stay inside the original requirements (both services, live `/chat` with no mock answer in live mode, flat snake_case alerts gated on `alert_id`, secret hygiene, no new deps, suite-green, old-wiring removed). While verifying the findings against source I also found **two inventory gaps** the review did not flag; both are fixed here (items 5–6).

1. **[MEDIUM] `MockAIProvider.test.ts` fixture swap to `environment:'qa'` breaks the `CRITICAL` severity assertion (contradicting the "assertions unchanged" claim).** **Addressed in §B.23.** Confirmed in source: `severityFor()` escalates to `CRITICAL` only when `anomalyType==='DatabaseConnectionTimeout' && input.environment.includes('production')`; with `qa`, 3 ERROR lines yield `HIGH`. The chosen handling: for the QA fixture change the assertion to `toBe('HIGH')` (honest for QA), and **retain CRITICAL-branch coverage** by adding one assertion that re-runs the same input with a bare `environment:'production'` — which is **not** in the AC17 forbidden set (only `production-eb`/`staging-eb` are), so the grep gate still passes. `severityFor()` production logic is left unchanged (mock-only heuristic; lower blast radius than editing it). The "assertions unchanged" claim is withdrawn.
2. **[MEDIUM] The proposed live-mode factory/service tests cannot flip `config.integrationMode` at runtime (`config` is a frozen singleton pinned to `mock` by `src/test/setup.ts`).** **Addressed in §B.22.** Confirmed in source: `config` is built once at import from a `process.env` snapshot; `resetIntegrations()` only clears the cached object; `liveConfigured()` reads the frozen value. The factory live-mode assertion is now specified via `vi.resetModules()` + set dummy env (`INTEGRATION_MODE=live` + dummy base URL/key) + `await import('./index')` (re-imports `../config` fresh; `dotenv` won't override already-set keys so no real creds leak), with env/modules restored in `finally`; a direct-construction fallback is documented. Acknowledge-survives-resync (AC7) is moved to a **repository-level** test driving `alertRepository.upsertLivePreservingStatus` → `acknowledge` → re-`upsertLivePreservingStatus` on the existing `freshTestDb()` harness, where no config gate applies.
3. **[NIT] The gate `npx vitest run` only passes in the backend workspace, not from the repo root.** **Addressed in NFR4 + AC18.** Confirmed: no root Vitest workspace exists; root `npx vitest run` skips the backend `setupFiles` (leaking the real `.env`'s live mode + QA creds into the mock-mode tests) and sweeps in `scripts/gen-diagram.test.js` (a `node:test` suite). The gate is restated as **`npm run test`** (which runs `vitest run` in `@urbani/backend` with its setup; equivalently `npm run test --workspace @urbani/backend` or `vitest run` from `packages/backend`). No root `vitest.workspace.ts` is added (unnecessary scope); it is noted as the only change required if a root run must be supported.
4. **[NIT] Making `ServiceSummary.enabled`/`.logGroup` required ripples to construction sites §B.12 didn't enumerate (tsc-break risk).** **Addressed in §B.12.** Confirmed: `ServiceSummary` is the return type of `serviceRepository.all()`/`findById()` and of `telemetryService.service(id)` (which returns `findById(id)` directly), and `mockServices` is typed `ServiceSummary[]`. The fields are now declared **OPTIONAL** (`enabled?`, `logGroup?`) and derived-at-read in **both** `telemetryService.services()` and `service(id)`; the repository `mapService()` and the `mockServices` literals are untouched (they omit the optional fields), keeping `tsc` clean with no migration.
5. **[self-found gap] `src/services/alertService.test.ts` carries forbidden tokens and was missing from the §B.23 inventory.** **Addressed.** Its `sampleAlert` fixture uses `service:'urbani-core-api'` + `environment:'production-eb'` (both forbidden under AC17) — the iteration-2 review's "matches only in listed files" note missed this. Added to §B.23 with a QA-value rewrite that is behavior-neutral (the fixture's `severity:'CRITICAL'` is a literal, and no test depends on the service/environment/model values).
6. **[self-found gap] AC17 grep scope did not exclude compiled output.** **Addressed.** `packages/backend/dist/` contains the stale tokens (e.g. the copied `001_initial_schema.sql`). AC17 now excludes `**/dist/**` and `**/node_modules/**` and notes that `npm run build` regenerates `dist/` clean from the corrected source, so the gate measures source + env + compose, not regenerable artifacts.

**Net effect on the suite (NFR4/AC18):** with the severity assertion corrected (1), the live-mode factory test using a fresh-config import (2), the acknowledge test at the repository layer (2), the gate run as `npm run test` (3), optional `ServiceSummary` fields (4), and the `alertService.test.ts`/`dist` cleanups (5–6), the full backend suite is planned **green** — the 2 currently-failing logs tests fixed, the chat/alerts/MockAIProvider fixtures rewritten to QA reality, and no new red introduced. No findings are backlogged; all remain consistent with the original requirements.
