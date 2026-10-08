# Urbani QA real-data integration — live chat, alerts, logs across both services

The change rewires the dashboard from the stale single-service EB account onto the real Urbani QA AWS account for **both** `main` and `payments`: live logs (latest + history merged), live Bedrock-generated alerts (flat snake_case ingest-on-read), and — the headline — a **live AI chatbot that POSTs the real `{base}/chat`** and returns the actual Nova 2 Lite markdown answer. The old `MockAIProvider` answer fallback is removed in live mode; a failed live chat now surfaces an honest HTTP 503 instead of a disguised mock answer. Surfaces (Settings, AI Insights, Services) are repointed to the real Nova 2 Lite model, the QA guardrail, both ECS log groups, the 5-minute collector, and the Lambda roster. All five mandatory design-review fixes are applied. Work is uncommitted, as the design requires (real creds + SQLite live in gitignored files).

Watch for: nothing blocking. The highest-risk area — the live `/chat` field mapping and its fail-closed behavior — is implemented exactly to spec and asserted in tests (confirmed). Secret hygiene is intact: the real `URBANI_API_KEY` lives only in the two gitignored `.env` files and never reaches source, `.env.example`, `docker-compose.yml`, logs, or any response body (confirmed). AC17 grep is clean (confirmed by running the gate). The coder's recorded evidence (tsc clean, 48/48 backend tests green incl. the 2 previously-failing logs tests, build green) is internally consistent and matches the source I read (confirmed).

**Verdict**: APPROVED

## High-level view

The live chat path is the center of gravity and it is correct. `HttpUrbaniChatProvider.askLogs` POSTs `{service, question}` with the **selected** service (presence-only `resolveService`, so a `payments` turn never silently becomes `main`), maps the 2xx body to markdown `answer` + `model_id`→`modelId` + evidence **counts**→honest `meta.note` + `citations: []` + `meta.source: 'LIVE'`, and emits no token counts from the wire. On non-2xx, network error, timeout, or a 2xx body with no recognizable answer field, it throws `ServiceUnavailableError` — never a mock answer, never a key leak. There is no mock-answer fallback left in live mode; the internal `MockAIProvider` is retained only for `analyzeTelemetry` delegation.

The chat failure mode is fail-closed and double-wrapped. `chatService.ask` gates the service to the enabled set before the provider is ever called, and wraps anything thrown around `askLogs` into a `ServiceUnavailableError` unless it already is one — so the Express handler returns a controlled 503 `CHAT_UNAVAILABLE`, never a 500. That is review fix #3, and it closes AC10's "never a 500" airtight.

Alerts map the real flat snake_case shape onto the shared contract exactly: `alert_id`→`alertId` with presence gating (absent on `/latest` ⇒ `[]`), `anomaly_type`→`anomalyType`, `probable_cause`→`probableCause`, the singular `recommendation` string → a single-element `recommendedActions` array (never split), `service_id`→`service`, `evidence: []`, `confidence: null` (the shared schema was widened to nullable), severity defaulting to MEDIUM, and `/alerts/history`→`body.alerts[]`. The nullable-confidence contract change is the honest realization of "QA returns no score" rather than a fabricated 0.5.

Logs read `/logs/latest` + `/logs/history`, flatten `windows[].logs[]` (with a defensive flat `logs[]` fallback), merge, de-dup on a natural key, and stable-sort newest-first. The two previously-failing tests are fixed against real QA shapes with real assertions: a non-200 degrades to `source:'LIVE'` + `[]` without throwing, and an unparseable timestamp resolves to `-Infinity` for ordering so it sorts **last**. Level is inferred from message text (with embedded-level unwrapping for stringified-JSON lines). The deterministic id hash shares the dedup key, so ids are stable across re-fetch.

Multi-service fan-out runs over `config.urbani.services` (both `main` and `payments`); `auth` and `support` are surfaced as registered-but-disabled and are never fetched. Service gating for chat lives in `chatService`, and the mock roster carries all four services while mock logs/metrics are generated from the enabled subset only (review fix #5).

Secret hygiene holds end to end: the key is read from env into `config.urbani.apiKey`, used only as an `x-api-key` request header, excluded from every `meta`/`answer`/`note`/thrown message, and never logged (the boot log explicitly omits it). Grepping the real key value finds it only in the two gitignored, untracked `.env` files.

The five mandatory fixes are all present: (1) the seed integration row id is the token-free `int-urbani-ecs` with a DELETE that clears any stale `URBANI_APP` row so a re-seed leaves exactly one; (2a) nullable confidence is asserted in the backend alerts-adapter suite and (2b) markdown URL sanitization is a pure DOM-free `@urbani/shared` helper unit-tested in the backend vitest, with no new frontend runner or deps; (3) `chatService` never 500s; (4) all "Nova Lite" comments now read "Nova 2 Lite"; (5) mock logs/metrics cover only the enabled subset.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings. All non-negotiable facts are honored, all five mandatory fixes are applied, the AC17 grep is clean, secret hygiene is intact, and the recorded verification evidence (tsc clean, 48/48 backend suite green including the 2 previously-failing logs tests, build green) is consistent with the source.

</details>

<details>
<summary>Details</summary>

### Live chat: faithful mapping, fail-closed, selected-service (confirmed)

`HttpUrbaniChatProvider.askLogs` is the single highest-risk surface and it matches §B.9/§B.9.1 line for line. The request sends exactly `{ service: resolveService(input.service), question: input.question }` under a 30s `AbortController`, with `x-api-key` as a header only. `resolveService` is presence-only — `typeof s === 'string' && s.trim() ? s : this.service` — so a provided `payments` is sent verbatim and never rewritten to the constructor default. The test "sends the SELECTED service (payments)" asserts the body is `{service:'payments', ...}`, which is the AC9 guarantee.

The 2xx mapping resolves the first non-empty string among `answer` → defensive `response`/`message`/`text`/`content`, passes it through verbatim (markdown preserved for client-side rendering), takes `model_id` (snake_case) with a defensive legacy `modelId` alias then the configured Nova 2 Lite label, builds the grounding note from `Number(body.evidence?.log_windows) || 0` and the alerts count (optional-chained so a missing `evidence` object renders `0/0` rather than throwing), sets `citations: []`, and `meta.source: 'LIVE'`. No token counts are read from the wire — `inputTokens`/`outputTokens` are local estimates for the usage/audit row, not claimed as model output.

The removal of the mock-answer fallback is complete and the failure mode is fail-closed: non-2xx, network error, timeout/abort, and a 2xx body with no recognizable answer field all throw `ServiceUnavailableError` with a safe message. The internal `MockAIProvider` is constructed but reachable only through `analyzeTelemetry` (no live analyze endpoint); `askLogs` never calls it. The warning logs include only `status` and the resolved service — never headers or the key. Tests cover all four throw paths and assert the key never appears in the thrown error or the result JSON.

### Chat 503 is double-wrapped — never a 500 (confirmed)

`chatService.ask` resolves `service` to an enabled service (or the default `main`) before the provider runs — disabled/unknown services never reach the live endpoint, which owns the "disabled services are never called" invariant for chat. The log-window fetch is wrapped so an expired-key 403 degrades to an empty window rather than failing the turn (the live `/chat` grounds server-side anyway). The `askLogs` call is wrapped and re-throws `e instanceof ServiceUnavailableError ? e : new ServiceUnavailableError()`, so any stray non-`AppError` is normalized to the controlled 503 `CHAT_UNAVAILABLE` instead of the handler's generic 500. That is review fix #3, and it makes AC10 airtight. The failed-turn audit records only `questionChars`, `logsSource`, and `outcome:'unavailable'` — no secrets.

### Alerts: flat snake_case → shared contract, honest nulls (confirmed)

`HttpUrbaniAlertsAdapter` treats the `/alerts/latest` body as the alert itself (not `body.alert`) and returns `[]` when `alert_id` is absent or empty; `/alerts/history` reads `body.alerts[]` and skips entries missing `alert_id`. `mapOne` produces `alertId` from `alert_id`, `service` from `service_id` (falling back to the queried service), `recommendedActions` as a single-element array only when `recommendation` is a non-blank string (never split on punctuation), `evidence: []`, `confidence: null`, severity normalized with a MEDIUM default, and `modelId` as the Nova 2 Lite label. Every mapped object is validated through `urbaniIncidentAlertSchema.safeParse`, so the nullable-confidence widening in `@urbani/shared/alerts.ts` is load-bearing: the backend test maps a live alert, asserts `confidence === null`, and asserts the alert is *not* dropped — which would fail if the schema were still non-nullable. That is review fix #2a landed in the runnable backend suite rather than an un-runnable shared test.

### Logs: merge/dedup/order, two failing tests fixed without weakening (confirmed)

`HttpUrbaniLogsAdapter.getLogs` fans out across enabled services (or the single requested one), fetches `/logs/latest` and `/logs/history?limit=N` per service, flattens `windows[].logs[]` (with a defensive flat `logs[]` fallback), and merges latest ∪ history. Dedup uses the natural key `service|sortKeyMs|message`, which is the same input as the deterministic SHA1-based id, so ids and dedup stay consistent and ids are stable across re-fetch. Ordering is governed by `sortKeyMs = parsedEntryMs ?? enclosingWindowEndMs ?? -Infinity` and a stable descending sort, kept separate from the human-facing display timestamp (which has its own `ts → window_end → now` fallback). Level is inferred from message text with word-boundary precedence, and a stringified-JSON message is unwrapped to use an embedded level/message if present.

The two previously-failing tests are now correct against real QA shapes with real assertions, not weakened ones. The non-200 test asserts `source:'LIVE'` + `value:[]` with no throw and no key leak. The ordering test provides a `not-a-date` line with no response-level `window_end` to borrow, and asserts the real newest line sorts first while the unparseable line sorts last — the exact bug the design calls out (a `now()` fallback previously outsorting real 2026 timestamps). The suite also covers latest+history mapping with inferred levels, cross-window dedup, embedded-JSON-level unwrapping, and level filtering over the merged window.

### Multi-service fan-out and the disabled roster (confirmed)

The integration factory constructs all three live adapters with `config.urbani.services` (both `main` and `payments`) and the environment label, and the boot log emits the service list, refresh cadence, model, and limits but explicitly not the key. The alerts and logs adapters iterate their enabled `services`; `auth` and `support` are never in that list, so they are never fetched. The mock roster (`mockServices`) carries all four so the Services page can show them as disabled, but `mockLogs`/`mockMetrics` are generated from an `enabledMockServices` filter (main, payments only) — review fix #5 — so disabled roster entries never carry seeded telemetry.

### Surfaces, config, and secret hygiene (confirmed)

`config/index.ts` defaults all resolve to QA: Nova 2 Lite for the chat and both Bedrock model ids, guardrail `0z947gmtk58a` plus the non-secret name/version, the ECS `main` log group, `us-east-1`, a 30s chat timeout, and the retired `URBANI_LOGS_WINDOW_MINUTES` replaced by `logsHistoryLimit`. `logGroupFor`/`logGroups` derive the two ECS groups from the environment label. The key is optional in the schema, read from env into `config.urbani.apiKey`, and used only as a request header. Grepping the real key value finds it only in `packages/backend/.env` and root `.env`, both gitignored and untracked (absent from `git status --porcelain`). The seed fix (#1) renames the integration row id to the token-free `int-urbani-ecs`, keeps `kind='URBANI_APP'` (which does not contain the forbidden substring), and deletes any stale `URBANI_APP` row whose id differs so a re-seed leaves exactly one row.

### Verification evidence (read, not re-run)

Per the task constraints I did not re-run tsc, the vitest suite, or the build. `qa-live-verification.md` records backend `tsc --noEmit` exit 0, `npm run test` 48/48 across 8 files (naming the 2 fixed logs tests, the nullable-confidence assertion, the markdown helper suite, the payments-routing chat test, and the live-mode factory via `vi.resetModules()`), and root `npm run build` exit 0 across shared/backend/frontend. The evidence is internally consistent and matches the source I read — the test files I inspected contain exactly the assertions the evidence claims. I ran only the one permitted spot-check, the AC17 grep, which is clean.

</details>

<details>
<summary>File map</summary>

Backend live integration: `HttpUrbaniChatProvider.ts` (live `/chat`, selected service, fail-closed 503, mock fallback removed), `HttpUrbaniAlertsAdapter.ts` (flat snake_case map, confidence null), `HttpUrbaniLogsAdapter.ts` (latest+history merge/dedup/order, inferred level), `integrations/index.ts` (live factory wiring), `lib/errors.ts` (`ServiceUnavailableError` 503 `CHAT_UNAVAILABLE`).

Backend services/config: `chatService.ts` (service gating + 503 wrap), `alertService.ts` (LIVE note), `settingsService.ts` (QA stack surfaces), `telemetryService.ts` (enabled/logGroup at read), `config/index.ts` (QA defaults, retired window-minutes), `config/urbaniQa.ts` (pipeline constants), `db/seed.ts` (QA roster + token-free integration id), `integrations/mock/mockData.ts` (4-service roster, enabled-subset telemetry), `repositories/alertRepository.ts` (pass null confidence).

Shared: `alerts.ts` (nullable confidence), `markdown.ts` (new pure DOM-free sanitizer/tokenizer), `domain.ts` (optional `enabled`/`logGroup`), `index.ts`/`package.json` (export + alias).

Frontend: `assistant/markdown.tsx` (React wrapper, no `dangerouslySetInnerHTML`), `useAssistantChat.tsx`/`AssistantMessage.tsx`/`AssistantPanel.tsx` (per-answer badge, honest unavailable copy, service selector), `pages/*` (QA copy, enabled selectors, Settings pipeline card), `api/endpoints.ts`, `vite.config.ts` (shared alias).

Tests: `HttpUrbaniChatProvider.test.ts`, `HttpUrbaniAlertsAdapter.test.ts`, `HttpUrbaniLogsAdapter.test.ts`, `lib/markdown.test.ts`, `integrations/index.test.ts`, `MockAIProvider.test.ts`, `services/alertService.test.ts`.

Full diff: `git diff` in `c:\Antigravity\Urbani DPI` (uncommitted; `.env` files gitignored and excluded).

</details>
