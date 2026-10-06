# Implementation Plan — Wire Urbani backend to live AWS APIs (chat + alerts)

Backend-only integration. NO frontend changes. NO second chat API. NO new npm deps.
Add new implementations behind existing seams; keep Mock as fallback. All paths absolute.

## Design decisions (grounded in the code that was read)

- **Chat provider shape.** `HttpUrbaniChatProvider implements AIProvider` (same interface as
  `MockAIProvider`). It POSTs `{service,question}` to `{base}/chat` with `x-api-key`, maps the AWS
  response onto `AskLogsResult`, and **delegates `analyzeTelemetry` to an internal `MockAIProvider`**
  because there is no AWS analyze endpoint (the proposal pipeline runs analyze server-side in
  Lambda, not via this API). This keeps the `AIProvider` contract fully satisfied without
  fabricating a Bedrock call. Rationale: the chatbot path (`chatService.ask`) only calls `askLogs`;
  `analyzeTelemetry` is driven by `aiService`, which has no live endpoint, so Mock is the honest
  source there.
- **Chat grounding / no-fabrication.** `chatService` already fetches the log window via the
  CloudWatch adapter and passes `logs` into `askLogs`. The live provider IGNORES those logs for
  answer generation (the AWS `/chat` grounds server-side on its own current window) but still maps
  the AWS empty-window response faithfully: `answer: "No log evidence was found..."`, `citations: []`.
  It never claims evidence exists when `evidence` is `[]`.
- **modelId when null.** AWS returns `modelId: null` on the empty-window response. Map a null/absent
  `modelId` to the configured label `apac.amazon.nova-lite-v1:0` (new config key `chatModelId`) so
  the provenance surface shows the real model name, WITHOUT adding fake citations. `provider` is the
  class name `HttpUrbaniChatProvider`.
- **log_count type.** `/chat` returns `log_count` as a NUMBER, `/logs/latest` returns it as a STRING.
  Both the chat provider and alerts adapter coerce defensively (`Number(x)`), mirroring the logs
  adapter's defensive mapping.
- **Chat error handling.** On network error / non-200 / abort, the live provider does NOT throw into
  `chatService` (which has no try/catch); it falls back to its internal `MockAIProvider.askLogs(input)`
  so the chat still answers from the fetched log window. Never log/return the key or a stack trace.
- **Alerts: route live data through the EXISTING alertService/SQLite boundary (ingest-on-read).**
  `alertService.list/get/acknowledge` return `PersistedAlert` (lifecycle status, acknowledgedBy,
  relatedLogIds) backed by `alertRepository` (SQLite). The `alerts` table already has a `data_source`
  column and `alertRepository.insert(alert, source)` accepts `'LIVE'`. Simplest correct option:
  in live mode, before serving, **sync** the live `/alerts/latest` + `/alerts/history` alerts into
  SQLite via `alertRepository.insert(alert, 'LIVE', 'OPEN')` (INSERT OR REPLACE — idempotent, keyed
  by `alertId`). Then the existing `list/get/acknowledge/relatedLogs` paths work UNCHANGED and
  acknowledge persists. The service returns `source: 'LIVE'` when live-configured. Rationale over
  pure pass-through: acknowledge, detail, relatedLogs, pagination, and filtering already depend on
  the repository; a pass-through read would duplicate all of that and break acknowledge. INSERT OR
  REPLACE preserves the alert body but NOTE the sync must not clobber an existing row's lifecycle
  status — see step 6 for the acknowledge-preserving guard. No schema migration required.
- **Alerts adapter interface.** The new `HttpUrbaniAlertsAdapter` exposes `getLatest()` and
  `getHistory(limit)` returning `UrbaniIncidentAlert[]` (the shared contract). It is NOT the
  `DynamoDBAdapter` interface (that is putAlert/getAlert/queryAlerts, a different shape); it is a new
  focused live source consumed by `alertService`. `MockDynamoDBAdapter` stays as-is for the analyze
  pipeline. The adapter mirrors the logs adapter's cache/stale-on-failure/no-key-leak discipline.
- **Severity mapping.** AWS severities seen are CRITICAL/HIGH; the shared enum is
  LOW/MEDIUM/HIGH/CRITICAL. Map CRITICAL/HIGH/MEDIUM/LOW through; anything else defaults to MEDIUM.

---

## Steps

- [ ] 1. Add live-integration config keys with safe defaults.
      Add to the zod schema and the `urbani` config block in `config/index.ts`:
      `URBANI_CHAT_MODEL_ID` (default `apac.amazon.nova-lite-v1:0`) -> `config.urbani.chatModelId`;
      `URBANI_CHAT_TIMEOUT_MS` (coerce number, default `20000`) -> `config.urbani.chatTimeoutMs`;
      `URBANI_ALERTS_HISTORY_LIMIT` (coerce number, default `5`) -> `config.urbani.alertsHistoryLimit`.
      Keep `logsConfigured` as the single gate (base URL + key). Do NOT hardcode base URL or key.
      Files: `c:\Antigravity\Urbani DPI\packages\backend\src\config\index.ts`
      Verify: `npx vitest run src/config` from the backend package (if a config test exists) OR
      `npx tsc -p tsconfig.json --noEmit` — compiles clean with the new keys.

- [ ] 2. Document the new keys (key-only, no secrets) in `.env.example`.
      Under the "Real Urbani telemetry API" section add `URBANI_CHAT_MODEL_ID=apac.amazon.nova-lite-v1:0`,
      `URBANI_CHAT_TIMEOUT_MS=20000`, `URBANI_ALERTS_HISTORY_LIMIT=5` with a comment that chat/alerts
      go live when `INTEGRATION_MODE=live` and the Urbani API is configured.
      Files: `c:\Antigravity\Urbani DPI\.env.example`
      Verify: visual — keys present, NO real key value committed.

- [ ] 3. Create `HttpUrbaniChatProvider` (new real `AIProvider`).
      Implements `AIProvider`: `readonly name = 'HttpUrbaniChatProvider'`, `readonly modelId` =
      `config.urbani.chatModelId`. Constructor takes `(baseUrl, apiKey, service, modelId, timeoutMs)`
      and builds an internal `new MockAIProvider(modelId)` as fallback.
      `analyzeTelemetry(input)` -> `return this.fallback.analyzeTelemetry(input)` (documented delegation).
      `askLogs(input)` -> POST `{base}/chat`, headers `{ 'x-api-key': apiKey, 'content-type':
      'application/json', accept: 'application/json' }`, body `JSON.stringify({ service: this.service,
      question: input.question })`, with an `AbortController` timeout (`timeoutMs`). On non-2xx or
      thrown error: log a safe warning (no key, no stack) and `return this.fallback.askLogs(input)`.
      On success map per the table below.
      Field mapping (AWS `/chat` 200 response -> `AskLogsResult`):
      - `answer` (string)        -> `answer` (string). If missing/empty, honest fallback string.
      - `evidence` (string[])    -> `citations` (string[]). If absent, `[]`. NEVER synthesize entries.
      - `modelId` (string|null)  -> used for `modelId`/`provider` surfacing: `modelId =
        body.modelId ?? this.modelId`. `provider = this.name`. Null modelId MUST NOT add citations.
      - `log_count` (number, defensively `Number(...)`) -> informational only; do not fabricate
        citations from it. (confidence/advisory have no field on `AskLogsResult` — drop them.)
      - `inputTokens`/`outputTokens` -> estimate like Mock (`Math.ceil(chars/4)` capped) since AWS
        doesn't return token counts.
      - `meta` -> `{ source: 'LIVE', note: 'Live Urbani chat (Bedrock Nova Lite).' }`.
      - `guardrailIntervened: false` (AWS does not expose this flag on /chat).
      SECURITY: never put `apiKey` in meta/note/answer/logs/thrown messages.
      Files: `c:\Antigravity\Urbani DPI\packages\backend\src\integrations\live\HttpUrbaniChatProvider.ts`
      Verify: `npx tsc -p tsconfig.json --noEmit` — compiles; unit tests added in step 4 pass.

- [ ] 4. Add unit tests for `HttpUrbaniChatProvider` (mirror `HttpUrbaniLogsAdapter.test.ts`).
      Use `vi.stubGlobal('fetch', ...)` with the real verified shapes. Cover:
      (a) empty-window response `{answer:"No log evidence was found in the current log window.",
      evidence:[], confidence:1.0, advisory:true, modelId:null, log_count:0}` -> `answer` passes
      through, `citations: []`, `modelId` falls back to `apac.amazon.nova-lite-v1:0`, `meta.source
      === 'LIVE'`;
      (b) evidence response (`log_count` NUMBER > 0, `evidence: ['ERROR ...']`, `modelId:
      'apac.amazon.nova-lite-v1:0'`) -> `citations` equals the evidence array, `answer` passes through;
      (c) assert the request carried header `x-api-key` === KEY, body contains the question and
      `service`, and `JSON.stringify(result)` does NOT contain KEY;
      (d) non-200 (e.g. 403) -> does NOT throw; returns the Mock fallback answer
      (`result.provider === 'MockAIProvider'` or `meta.source === 'MOCK'`);
      (e) network throw (fetch rejects) -> same graceful Mock fallback.
      Files: `c:\Antigravity\Urbani DPI\packages\backend\src\integrations\live\HttpUrbaniChatProvider.test.ts`
      Verify: `npx vitest run src/integrations/live/HttpUrbaniChatProvider.test.ts` — all pass.

- [ ] 5. Create `HttpUrbaniAlertsAdapter` consuming `/alerts/latest` and `/alerts/history`.
      Class with `getLatest(): Promise<UrbaniIncidentAlert[]>` (0 or 1 item) and
      `getHistory(limit: number): Promise<UrbaniIncidentAlert[]>`. Constructor
      `(baseUrl, apiKey, service, refreshMinutes)`; cache both responses with a TTL = refresh window
      (like the logs adapter); on fetch failure serve stale cache if present, else return `[]`
      (do NOT break the Alerts page). GET with `x-api-key` + `accept` headers, `AbortController`
      timeout. Never log/return the key.
      Mapping (AWS alert object -> `UrbaniIncidentAlert`):
      - `/alerts/latest` body `{service_id, alert}` -> take `body.alert`; if null/absent -> `[]`.
      - `/alerts/history` body `{service_id, count, alerts}` -> take `body.alerts` (array).
      - Per alert object -> domain fields:
        `alertId` <- `alertId` (fallback `randomUUID()` if absent),
        `timestamp` <- ISO-normalize `timestamp` (reuse the logs adapter's `iso` approach; default now),
        `service` <- `service ?? service_id ?? this.service`,
        `environment` <- `environment ?? 'production-eb'`,
        `severity` <- normalize `severity` to the enum (CRITICAL/HIGH/MEDIUM/LOW, else MEDIUM),
        `anomalyType` <- `anomalyType ?? 'UnknownAnomaly'`,
        `summary` <- `summary ?? ''`,
        `evidence` <- `Array.isArray(evidence) ? evidence.map(String) : []`,
        `probableCause` <- `probableCause ?? ''`,
        `recommendedActions` <- `Array.isArray(recommendedActions) ? recommendedActions.map(String) : []`,
        `confidence` <- clamp `Number(confidence)` into [0,1], default 0.5,
        `modelId` <- `modelId ?? config.urbani.chatModelId`.
      Validate each mapped object against the shared contract defensively (skip malformed entries).
      Files: `c:\Antigravity\Urbani DPI\packages\backend\src\integrations\live\HttpUrbaniAlertsAdapter.ts`
      Verify: `npx tsc -p tsconfig.json --noEmit` — compiles; tests in step 7 pass.

- [ ] 6. Make `alertService` serve live alerts through its existing boundary (ingest-on-read),
      preserving acknowledge/detail and provenance.
      Add a module-private helper that, when `config.integrationMode === 'live' &&
      config.urbani.logsConfigured`, obtains the live alerts adapter (from the integrations factory,
      step 8) and upserts its latest+history alerts into SQLite before the query/get runs. Guard
      against clobbering lifecycle: in `alertRepository`, the INSERT OR REPLACE currently resets
      `status` to the passed value — add an `insertPreservingStatus` path (or make `insert` look up
      an existing row's `status/acknowledged_by/acknowledged_at` and keep them when the row already
      exists) so re-syncing a LIVE alert does NOT un-acknowledge it. In `alertService`, set
      `source` to `'LIVE'` (with a live note) when live-configured, else keep `'MOCK'`.
      `get`/`acknowledge` need no behavior change beyond the source label — they already read SQLite.
      Keep `MOCK_NOTE` for mock mode; add a short live note constant for live mode.
      Files: `c:\Antigravity\Urbani DPI\packages\backend\src\services\alertService.ts`,
      `c:\Antigravity\Urbani DPI\packages\backend\src\repositories\alertRepository.ts`
      Verify: `npx vitest run src/services/alertService.test.ts` — existing tests still pass
      (mock mode unchanged: source stays MOCK, acknowledge works).

- [ ] 7. Add unit tests for `HttpUrbaniAlertsAdapter` (mirror the logs adapter test).
      `vi.stubGlobal('fetch', ...)` returning the real shapes:
      latest `{service_id:'urbani-app', alert:{alertId:'ALT-789A3CCEB56F', severity:'CRITICAL',
      timestamp:'2026-10-05T10:47:54.190651+00:00', service:'urbani-app', environment:'test',
      anomalyType:'DatabaseConnectionTimeout', summary:'...', probableCause:'...',
      recommendedActions:['...'], evidence:['ERROR ...'], confidence:0.95,
      modelId:'apac.amazon.nova-lite-v1:0'}}`; history `{service_id, count:2, alerts:[...]}`.
      Assert: mapped objects satisfy the domain shape (alertId/severity/evidence present),
      `x-api-key` header sent, KEY never in `JSON.stringify(result)`, `alert:null` latest -> `[]`,
      non-200 -> returns `[]` (or stale cache) without throwing.
      Files: `c:\Antigravity\Urbani DPI\packages\backend\src\integrations\live\HttpUrbaniAlertsAdapter.test.ts`
      Verify: `npx vitest run src/integrations/live/HttpUrbaniAlertsAdapter.test.ts` — all pass.

- [ ] 8. Wire both new pieces into `buildLive()` and expose the alerts adapter.
      In `integrations/index.ts`: add `urbaniAlerts?: HttpUrbaniAlertsAdapter` (or a small
      `LiveAlertsSource` interface) to the `Integrations` type as optional. In `buildLive()`, when
      `config.urbani.logsConfigured`: construct `HttpUrbaniChatProvider` and assign to
      `base.aiProvider`; construct `HttpUrbaniAlertsAdapter` and assign to `base.urbaniAlerts`; log a
      boot line `'Wiring LIVE Urbani chat + alerts integration'` (service + refreshMinutes only, NO
      key). Keep `buildMock()` untouched (Mock remains fallback; `urbaniAlerts` undefined in mock).
      `alertService` (step 6) reads `getIntegrations().urbaniAlerts` for the live sync; when
      undefined it stays mock. Keep `setIntegrationsForTesting` working with the new optional field.
      Files: `c:\Antigravity\Urbani DPI\packages\backend\src\integrations\index.ts`
      Verify: `npx vitest run src/integrations/index.test.ts` — existing factory tests still pass
      (mock mode: aiProvider.name === 'MockAIProvider', no urbaniAlerts required).

- [ ] 9. Update `settingsService.runtimeIntegrationState()` so BEDROCK and DYNAMODB report
      LIVE/CONNECTED under live mode.
      Change the `BEDROCK` and `DYNAMODB` cases: when `config.integrationMode === 'live' &&
      config.urbani.logsConfigured` return `{ mode: 'LIVE', status: 'CONNECTED' }`, else keep the
      seeded mode/status. Update the comment block (chat=Bedrock and alerts=DynamoDB are now genuinely
      live). CLOUDWATCH/URBANI_APP logic stays as-is.
      Files: `c:\Antigravity\Urbani DPI\packages\backend\src\services\settingsService.ts`
      Verify: `npx vitest run src/services` — settings/related tests pass (if a settingsService test
      exists); otherwise `npx tsc -p tsconfig.json --noEmit` compiles.

- [ ] 10. Full backend typecheck + test suite + build.
      Files: none (verification only).
      Verify (run from `c:\Antigravity\Urbani DPI\packages\backend`):
      `npx tsc -p tsconfig.json --noEmit` (clean), then `npx vitest run` (all tests pass), then
      `npm run build` (tsc build + copy-assets succeeds). Fix any regression before finishing.

- [ ] 11. Runtime verification against the LIVE AWS endpoints (do NOT skip — the user reports the
      chatbot still returns the same/mock values, so prove the wiring end to end).
      Preconditions: `c:\Antigravity\Urbani DPI\packages\backend\.env` has `INTEGRATION_MODE=live`,
      `URBANI_API_BASE_URL=https://830oi1gxng.execute-api.ap-south-1.amazonaws.com/prod`,
      `URBANI_API_KEY=<real key>`, `URBANI_SERVICE=urbani-app`. (User asked to clear cache / run the
      latest dev build — restart the dev server so new env + code load; the in-process adapter cache
      is per-run so a restart clears it.)
      Procedure:
      a. Smoke-test the raw AWS endpoints server-side (PowerShell), confirming shapes:
         `Invoke-RestMethod -Method Post -Uri "$base/chat" -Headers @{'x-api-key'=$key} -ContentType
         'application/json' -Body '{"service":"urbani-app","question":"Are there any errors right now?"}'`
         and the three GETs (`/logs/latest`, `/alerts/latest`, `/alerts/history?limit=5`), each with
         the `x-api-key` header. Record the actual `answer`, `evidence`, `modelId`, and alert objects.
      b. Start the backend (`npm run dev` from the backend package) and confirm the boot log line
         `Wiring LIVE Urbani chat + alerts integration` appears and the key is NOT in any log.
      c. Log in to get a bearer token, then `POST /api/chat` with a real question and confirm the
         response `source === 'LIVE'`, `provider === 'HttpUrbaniChatProvider'`, `modelId` reflects
         Nova Lite, and the `answer`/`citations` match what the raw AWS `/chat` returned in (a)
         (i.e. NOT the deterministic Mock phrasing). This is the proof the user's issue is fixed.
      d. Confirm empty-window honesty: if the window is empty, `answer` is the AWS no-evidence
         sentence and `citations` is `[]` (no fabrication).
      e. `GET /api/alerts` returns `source: 'LIVE'` with the real alert(s); `GET /api/alerts/:id`
         (detail) and `POST /api/alerts/:id/acknowledge` still work and acknowledge persists across a
         re-sync (does not revert to OPEN).
      f. Fault injection: temporarily point the key/base at an invalid value and confirm chat still
         answers via Mock fallback (no crash) and alerts degrade to `[]`/stale without a 500; then
         restore. Confirm the key never appears in responses or logs.
      If any live call fails or returns unexpected shapes, capture the exact status/body, adjust the
      defensive mapping, and re-verify — do not declare success on code reading alone.

## What this plan does NOT touch (hard constraints)
- No frontend files. No change to the `AIProvider` interface or `MockAIProvider`.
- No second chat API; `POST /api/chat -> chatService.ask` stays the only frontend-facing chat route.
- No new npm dependencies; uses built-in `fetch` + `AbortController` like the logs adapter.
- No Bedrock/AWS SDK, no RAG/vector/embeddings/LangChain.
- No DB schema migration (the `alerts.data_source` column already exists). The only repository
  change is making re-sync acknowledge-preserving (step 6) — behavior-preserving, no schema change.
- API key stays server-side only (read from `config.urbani.apiKey`), never logged/returned.
```
