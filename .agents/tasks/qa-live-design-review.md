# Design Review (iteration 3) — Urbani QA Real-Data End-to-End Integration

**Design under review:** `.agents/tasks/qa-live-design.md`
**Verdict:** CHANGES_REQUESTED (2 MEDIUM, 3 NIT)
**Reviewed:** fresh, against the actual source tree, with the backend test suite + type-check run.

---

## How this was checked

Every "the current code does X" claim in the design was verified by reading the referenced source, and two gates were executed:

- `npm run test` (canonical, backend workspace): **2 failed / 36 passed** — both failures in `HttpUrbaniLogsAdapter.test.ts` (`maps varied upstream log shapes…` and `surfaces an IntegrationError on non-200…`), exactly as the design states.
- `npx tsc -p tsconfig.json --noEmit` (backend): **clean (exit 0)** — confirms the "backend tsc is clean" baseline.
- (`npm run build` was **not** re-run in this pass; the backend type-check + the full test transpile both succeeded, so the baseline compiles.)

The design is well-grounded. It honors every non-negotiable task fact — live `POST /chat` with the mock-answer fallback removed in live mode and an honest 503 on failure, both services covered with `auth`/`support` disabled-and-never-called, flat snake_case alerts gated on `alert_id` (`recommendation` string → single-element array, confidence `null`, evidence `[]`), logs latest+history merge/dedup with level inferred from message, secret hygiene (no key value in the design), no new runtime deps/SDK/RAG, single `POST /api/chat`, old-account wiring targeted for removal. It has also correctly resolved **all four** findings from the iteration-2 review (see "Prior findings" below).

The two blocking findings below are **new** (not raised in iterations 1–2): one is a concrete hole in the old-wiring removal that makes the AC17 grep gate unmeetable as written; the other is a test-plan/infrastructure gap for the two newly-specified non-backend tests. Neither contradicts a non-negotiable fact, but both block the stated acceptance gates (AC17 / NFR4 / AC18) and so warrant a quick loop-back.

---

## Prior findings (iteration 2) — all resolved in this version

- **iter2-1 (MockAIProvider `CRITICAL` assertion):** resolved in §B.23 — the design now changes the QA assertion to `HIGH` and adds a bare-`environment:'production'` re-run to keep the `CRITICAL` branch covered; the "assertions unchanged" claim is explicitly withdrawn. Verified against `severityFor()`.
- **iter2-2 (frozen `config` singleton):** resolved in §B.22 — live-mode factory assertion via `vi.resetModules()` + dynamic `await import('./index')`; acknowledge-survives-resync moved to a repository-level test. Verified against `config/index.ts`, `test/setup.ts`, `integrations/index.ts`, `alertService.ts`.
- **iter2-3 (gate wording):** resolved in NFR4/AC18 — gate restated as `npm run test` (backend workspace), not a bare root `npx vitest run`. Verified against root/`backend` `package.json` and the single backend `vitest.config.ts`.
- **iter2-4 (`ServiceSummary` required-fields ripple):** resolved in §B.12 — fields declared **optional** and derived-at-read in both `services()` and `service(id)`. Verified against `domain.ts`, `telemetryRepository.ts` (`mapService`/`serviceRepository`), `telemetryService.ts`, `mockData.ts`.

---

## Findings

### 1. [MEDIUM] The old-wiring removal leaves the `int-urbani-app` seed-row **id**, so the AC17 grep gate still matches `urbani-app`

**Where:** `.agents/tasks/qa-live-design.md` §B.17 (seed integration rows) and §B.23 (seed.ts inventory entry); actual file `packages/backend/src/db/seed.ts` (the `integrations` array). AC17.

**Problem:** AC17 requires a scoped grep over `packages/**/*.{ts,tsx,sql}` to return **zero** matches for `urbani-app`. §B.17 says only: *"rename `int-urbani-app` **display** `Urbani Application (Elastic Beanstalk)` → `Urbani QA ECS services (main, payments)`"* and §B.23 says *"integration **display names**."* Both change element `[2]` (the display string) of this row but keep element `[0]`, the id literal `'int-urbani-app'`:

```ts
// packages/backend/src/db/seed.ts (current)
['int-urbani-app', 'URBANI_APP', 'Urbani Application (Elastic Beanstalk)'],
// after the §B.17 edit as written:
['int-urbani-app', 'URBANI_APP', 'Urbani QA ECS services (main, payments)'],  // still contains "urbani-app"
```

`seed.ts` is a `.ts` file under `packages/**` and is **not** excluded by AC17. The id `int-urbani-app` contains the forbidden substring `urbani-app` (word boundaries don't help — the `-` characters create boundaries, so even `\burbani-app\b` matches). So the grep returns a non-zero match in `seed.ts`, and **AC17 fails** — and with it the AC18 bundle that incorporates the grep-clean. The iteration-2 review's "matches only in listed files" note conflated *file is in the inventory* with *the planned edit removes the token*; it does not here. (`URBANI_APP`, the row's `kind`, is uppercase-with-underscore and does **not** match `urbani-app`, so it is correctly left alone.)

**Concrete fix:** Also change the row **id** to a token-free value and say so in §B.17/§B.23, e.g.:

```ts
['int-urbani-ecs', 'URBANI_APP', 'Urbani QA ECS services (main, payments)'],
```

Caveat to specify: `integrations.kind` is **not** UNIQUE (only `id` is the PRIMARY KEY — see `001_initial_schema.sql`), so re-seeding an **already-seeded** DB with a new id performs `INSERT OR REPLACE` on the new PK and leaves the stale `int-urbani-app` row behind → two `URBANI_APP` rows → a duplicate integration on the Settings page. Resolve by seeding into a fresh/reset DB (the gitignored demo SQLite, the normal demo flow) **or** adding a one-time `DELETE FROM integrations WHERE id = 'int-urbani-app'` in the seed. Keep `kind = 'URBANI_APP'` and the `settingsService` `case 'URBANI_APP':` unchanged.

---

### 2. [MEDIUM] §B.22 specifies a shared test and a frontend markdown test, but only the backend has a test runner and the canonical gate runs only the backend workspace

**Where:** §B.22 ("**New `shared` test**: `urbaniIncidentAlertSchema` accepts `confidence: null`…" and "**New frontend `markdown.test.ts(x)`** — asserts … a `javascript:` link is rendered as literal text"); NFR4/AC18 ("the full suite goes green" / gate = `npm run test`). Files: `packages/shared/package.json`, `packages/frontend/package.json`, `packages/backend/vitest.config.ts`.

**Problem:** Verified against source:
- The **only** vitest config is `packages/backend/vitest.config.ts` (`include: ['src/**/*.test.ts']`, run with cwd `packages/backend`). The canonical gate is `npm run test` → `npm run test --workspace @urbani/backend` → `vitest run` in the backend only.
- `packages/shared/package.json` has **no** `test` script and **no** vitest.
- `packages/frontend/package.json` has **no** `test` script and **no** vitest / jsdom / `@testing-library/react`.
- There are no `*.test.*` files anywhere under `packages/shared` or `packages/frontend`, and `vitest` is not referenced in either package.

So the two tests §B.22 introduces **cannot be executed by any configured runner**. The frontend `markdown.test.tsx` is the material one: `markdown.tsx` (§B.14.1) renders untrusted model output and must neutralize `javascript:`/`data:` URLs and avoid `dangerouslySetInnerHTML` — the design commits to a unit test proving the `javascript:`-link neutralization, yet there is no way to run it, and standing up a React-component runner needs new **dev** dependencies (vitest + jsdom/happy-dom + testing-library) and config that the design never enumerates (and should reconcile with NFR2's "no new deps"). As written, §B.22 and the "full suite planned green" claim (NFR4) are internally inconsistent for these two items.

**Concrete fix:**
- *Shared / nullable-confidence:* move the assertion into the **backend** suite, where it runs. It is largely covered already: `HttpUrbaniAlertsAdapter.mapMany` does `urbaniIncidentAlertSchema.safeParse(mapped)`, so the rewritten alerts-adapter test asserting a live alert with `confidence: null` **will fail if the schema is left non-nullable** (the alert would be skipped as malformed). Keep that assertion and drop the un-runnable standalone shared test (or state that shared's only gate is `tsc`/build).
- *Frontend markdown:* either (a) factor the URL-sanitization + tokenization into a **pure, DOM-free** helper that the backend vitest can import and assert (`javascript:`/`data:` → neutralized, scheme allowlist), keeping the React wrapper verified by `tsc -b` + `vite build`; **or** (b) explicitly add a frontend test runner (vitest + jsdom/happy-dom + `@testing-library/react` as **dev** deps) + a `test` script + config, call it out against NFR2, and wire it into (or alongside) the gate. State the choice in §B.22 and align NFR4/AC18 so "full suite green" names exactly what runs.

---

### 3. [NIT] §B.9.2's "re-throw any error" can surface an HTTP 500, which AC10 forbids

**Where:** §B.9.2 ("On a thrown error (the live provider's `ServiceUnavailableError`, or **any error**) … **re-throw** so the Express error handler returns the controlled 503"). `errorHandler.ts`, `chatService.ts`.

**Problem:** The error handler returns 503 **only** for a 503-mapped `AppError`; any non-`AppError` that reaches it is rendered as a generic `500 INTERNAL_ERROR`. Re-throwing *"any error"* verbatim therefore risks a 500 on an unexpected (non-`ServiceUnavailableError`) throw, contradicting AC10's "**never a 500**." In practice `askLogs` is specified to only ever throw `ServiceUnavailableError` (non-2xx / network / timeout / abort / unmappable-2xx all funnel through it), so this is latent rather than active — but the wording invites a literal implementation.

**Concrete fix:** Specify that `chatService` wraps anything caught around `askLogs` that is **not** already a 503-mapped `AppError` into a `ServiceUnavailableError` before re-throwing (e.g. `catch (e) { …audit…; throw e instanceof ServiceUnavailableError ? e : new ServiceUnavailableError(); }`). That makes AC10's "never a 500" airtight regardless of the thrown type.

---

### 4. [NIT] Residual "Nova Lite" code comments are not in the relabel inventory

**Where:** `packages/backend/src/config/index.ts` (comment above `URBANI_CHAT_MODEL_ID`: "Live chat (Bedrock Nova Lite …)") and `packages/backend/src/services/settingsService.ts` (doc comment "the real Bedrock Nova Lite /chat endpoint"). Neither is listed for edit in §B.4/§B.16/§B.23.

**Problem:** The design relabels every *user-facing* surface and the `LIVE_NOTE`/boot log to "Nova 2 Lite," but these two **code comments** still say "Nova Lite." They are not AC17-forbidden tokens (so they do not fail any gate), but they are inconsistent given the task's "don't miss anything" and the otherwise-thorough relabel.

**Concrete fix:** Update both comments to "Nova 2 Lite" when touching those files (both are already in the edit set for other reasons).

---

### 5. [NIT] §B.17 says mock logs/metrics "reference main/payments," but they are generated by iterating the full roster (now including disabled `auth`/`support`)

**Where:** §B.17; `packages/backend/src/integrations/mock/mockData.ts` (`mockLogs` and `mockMetrics` iterate `mockServices`).

**Problem:** §B.17 expands `mockServices` to the 4-entry QA roster (`main`, `payments`, plus disabled `auth`, `support`) and separately says `mockLogs`/`mockMetrics` should "reference `main`/`payments`." But `mockLogs` uses `mockServices[i % mockServices.length]` and `mockMetrics` is `mockServices.flatMap(...)`, so if the roster has four entries they will also emit `auth`/`support` rows. In **live** mode metrics stay MOCK, so the Metrics page would then show telemetry for services the roster marks disabled — a mild honesty/consistency wrinkle (still MOCK-labeled, so not a provenance violation).

**Concrete fix:** Generate `mockLogs`/`mockMetrics` from the **enabled** subset only (e.g. `mockServices.filter(s => s.enabled !== false)` or an explicit `[main, payments]` list), or state in §B.17 that disabled services intentionally carry seeded telemetry too.

---

## Verified Assumptions (design claims checked against source — all accurate)

- **2 failing logs tests, exactly as described.** `npm run test` → 2 failed / 36 passed; both in `HttpUrbaniLogsAdapter.test.ts`: the non-200 case now resolves `{source:'LIVE', value:[]}` instead of rejecting (old `rejects.toThrowError(/HTTP 403/)` fails), and the unparseable-timestamp "plain string line" sorts to index 0 (its `new Date().toISOString()` fallback outranks the 2026 timestamps), failing the `value[0] === 'DB pool timeout'` assertion. Backend `tsc --noEmit` clean.
- **Chat provider (`HttpUrbaniChatProvider.ts`):** POSTs `{base}/chat`; constructor takes `windowMinutes`; sends the fixed `this.service` (the multi-service bug — `payments` would query `main`) and `minutes` when `windowMinutes>0`; falls back to `MockAIProvider` on non-2xx **and** on catch; reads `body.modelId` (camelCase) and `body.evidence` as an **array** → citations; substitutes a canned "No log evidence…" string on empty answer; `meta.note` says "Nova Lite." Matches the "current state" §B.9 describes.
- **Logs adapter (`HttpUrbaniLogsAdapter.ts`):** only `/logs/latest`; `?minutes=N`; `throw new IntegrationError` on non-200 is caught internally → `getLogs` returns `[]` (never rejects); unparseable timestamp → `now()`; sort is a descending **string** compare on `timestamp`; `environment` hardcoded `'qa'`; `randomUUID` imported from `node:crypto`.
- **Alerts adapter (`HttpUrbaniAlertsAdapter.ts`):** reads wrapped `body.alert`; camelCase fields; `confidence` defaults to `0.5`; absent `alertId` → `randomUUID()`; `evidence`/`recommendedActions` read as arrays; constructor `(baseUrl, apiKey, service, refreshMinutes, services?)`.
- **Config (`config/index.ts`):** defaults `CLOUDWATCH_LOG_GROUP=/aws/elasticbeanstalk/urbani-app`, `URBANI_CHAT_MODEL_ID=apac.amazon.nova-lite-v1:0`, `URBANI_CHAT_TIMEOUT_MS=20000`, primary `anthropic.claude-3-5-sonnet…`, fallback `amazon.nova-lite-v1:0`, guardrail `urbani-dpi-guardrail-v1`; `URBANI_LOGS_WINDOW_MINUTES` present; `URBANI_SERVICE` default `main`; `URBANI_SERVICES` → `[service]` fallback; no `URBANI_ENVIRONMENT`/`…HISTORY_LIMIT`/`BEDROCK_GUARDRAIL_NAME`/`…VERSION`. `config` is `export const config = {…} as const` built once at import.
- **Shared contract (`alerts.ts`):** `confidence: z.number().min(0).max(1)` (non-nullable); `modelId: z.string()`; `recommendedActions: z.array(z.string())`. SQLite `alerts.confidence` is a nullable `REAL`. Matches §B.8's premise.
- **`alertRepository`:** `rowToAlert` → `confidence: row.confidence ?? 0`; `insert`/`upsertLivePreservingStatus` bind `alert.confidence` directly; `upsertLivePreservingStatus` preserves `status`/`acknowledged_*`; `acknowledge` gated on `status='OPEN'`. Supports §B.8 and the repository-level ack test (§B.22).
- **Error taxonomy (`errors.ts` + `middleware/errorHandler.ts`):** `AppError(code, message, statusCode, details?)`; handler maps any `AppError` → `res.status(statusCode)` with `{error:{code,message,details,correlationId}}`, logs 5xx as error / 4xx as warn (no key/stack), `ZodError`→400. A `ServiceUnavailableError extends AppError` (503, `CHAT_UNAVAILABLE`) is compatible and surfaces a safe body.
- **`chatService.ts`:** defaults `service='urbani-app'`, `environment='production-eb'`; no enabled-service gating; `askLogs` **not** wrapped in try/catch today; `/chat` route uses `asyncHandler` so a thrown `AppError` reaches the handler.
- **`apiRoutes.ts`:** single `POST /chat` → `chatService.ask`; `chatSchema.question = z.string().min(1).max(1000)` with **no** `.trim()`. `GET /services` → `telemetryService.services()`, `GET /services/:id` → `telemetryService.service(id)`.
- **`AIProvider` / `MockAIProvider`:** `AskLogsInput` = `{question,logs,service,environment,history?}` (no `incidentAnalyses`); `AskLogsResult` matches §B.9.1's target fields; `MockAIProvider.askLogs` is deterministic and never throws (mock-mode chat stays 200, AC11); `severityFor()` → `CRITICAL` only when `anomalyType==='DatabaseConnectionTimeout' && environment.includes('production')`, else 3 errors → `HIGH` (so `'qa'`→`HIGH`, bare `'production'`→`CRITICAL`) — confirming §B.23's revised handling.
- **Integration factory (`integrations/index.ts`):** `buildLive()` constructs the three live sources passing `logsWindowMinutes` to logs+chat and **no** `services`/`environment`; `buildMock()` has no `urbaniAlerts`; `resetIntegrations()` only nulls the cache (does not re-read env); boot log never logs the key.
- **`settingsService.ts`:** `runtimeIntegrationState` returns `{LIVE,CONNECTED}` for `CLOUDWATCH`/`URBANI_APP`/`BEDROCK`/`DYNAMODB` when `integrationMode==='live' && logsConfigured`; `SettingsView` lacks `logGroups`/`guardrailName`/`guardrailVersion`/`pipeline`.
- **`alertService.ts`:** ingests-on-read via `syncLiveAlerts()` (early-returns on `!liveConfigured()`), de-dups by `alertId`, swallows failures; `LIVE_NOTE` says "Nova Lite." Confirms §B.11/AC7 and the §B.22 rationale (a `setIntegrationsForTesting` fake is never queried in mock mode).
- **Migrations:** `migrate.ts` keys applied migrations by **filename** (`version = file.replace(/\.sql$/,'')`) in `schema_migrations`, so the comment-only `001_initial_schema.sql` edit is safe (fresh DB runs identical DDL; applied DBs are not re-run). `001_initial_schema.sql` comments contain `production-eb`, `staging-eb`, `urbani-core-api`; `integrations.kind` is **not** UNIQUE (relevant to Finding 1).
- **Frontend:** `useAssistantChat` defaults `service='urbani-app'`, `environment='production-eb'`, sets the assistant message badge from `res.data.logsSource` (not the answer provenance `res.source`), and has an `isError` bubble using `API_ERROR_MESSAGE`; `AssistantMessage` renders `content` as plain text and shows the badge only when `meta` is present (so the error bubble carries no badge); `api/client.ts` throws `ApiClientError` on any non-2xx (so a 503 reaches the `catch` → honest error bubble); `endpoints.ts` exposes `Sourced<ChatAnswer>` (so `res.source` is available for the AC16 badge fix) and mirrors `SettingsView`; `Confidence` renders `null → —`; `AIAnalysis.confidence` is already `number | null`. Confirms §B.8/§B.13/§B.14/AC10/AC16.
- **Old-account state (AC19):** root `.env` points dev at the OLD account (`830oi1gxng.execute-api.ap-south-1.amazonaws.com/prod`, `URBANI_SERVICE=urbani-app`, old key); `packages/backend/.env` resolves to QA via last-wins in its bottom block (base URL/key/`URBANI_SERVICES=main,payments`/`URBANI_SERVICE=main`/`URBANI_CHAT_MODEL_ID`/`BEDROCK_PRIMARY_MODEL_ID`/`BEDROCK_GUARDRAIL_ID` all Nova 2 Lite / `0z947gmtk58a`), while **top-block-only** keys stay stale — `CLOUDWATCH_LOG_GROUP=/aws/elasticbeanstalk/urbani-app` and `BEDROCK_FALLBACK_MODEL_ID=amazon.nova-lite-v1:0` — exactly the keys §B.18 says to fix. `docker-compose.yml` defaults `URBANI_SERVICE` to `urbani-app`, lacks a `CLOUDWATCH_LOG_GROUP` passthrough, and defaults primary model/guardrail to the old values. `.env.example` carries `urbani-app` / `apac.amazon.nova-lite-v1:0` / `/aws/elasticbeanstalk/urbani-app`.
- **Secret hygiene:** the real `URBANI_API_KEY` value does **not** appear anywhere in the design document, and the review deliberately references the key by name only.
- **Old-wiring inventory completeness:** a scoped grep for the forbidden tokens over `packages/**/*.{ts,tsx,sql}` returns matches only in files §B.23 lists — **except** the `int-urbani-app` id in `seed.ts`, whose planned edit does not remove the token (**Finding 1**). The `gen-diagram.test.js` node:test suite exists (confirming the NFR4/AC18 gate-wording rationale).

## Unverified / Wrong Assumptions

**Wrong / incomplete:**
- §B.17/§B.23's old-wiring removal for `seed.ts` is **incomplete** — renaming only the display string leaves the `int-urbani-app` id, so AC17 is not met. See **Finding 1**.
- §B.22 treats a new shared test and a new frontend markdown test as part of the planned-green suite, but **no runner exists** for either package and the gate is backend-only. See **Finding 2**.

**Unverified (acknowledged by the design; not independently confirmable in a design review without calling the live QA API):**
- The exact QA `/chat` response field names — `answer` (markdown), `evidence: { log_windows, alerts }` (counts object), `model_id` (snake_case). The only in-repo probe (`.agents/_logs2.txt`) is the OLD account; the task confirms `/chat` "is returning real Bedrock responses" (so the route works) but does not provide its JSON body. This is the single highest-impact external assumption. **Mitigation is adequate and should be kept:** §B.0 makes pinning the real field names a hard gate before any mapper edit; §B.9.1 resolves `answer` against defensive aliases and **throws `ServiceUnavailableError` (honest 503) on an unmappable 2xx body** rather than emitting a canned string under a LIVE badge; the grounding note uses `Number(body.evidence?.…) || 0`. No code change is requested here beyond honoring §B.0 during implementation.
- The exact `/logs/history` envelope (`windows[].logs[]` of `{timestamp, message}`) and the `/alerts/*` flat snake_case field spellings. These are largely pinned by the task's non-negotiable facts (flat snake_case alerts gated on `alert_id`; `recommendation` string → single-element array; logs history flattened/merged/deduped; level inferred). The adapters stay defensive (flat-`logs[]` fallback, `safeParse` skip, severity clamp, `-Infinity` sort key for unresolved timestamps), so a surprise degrades honestly rather than crashing or fabricating. Acceptable; pin via §B.0.
