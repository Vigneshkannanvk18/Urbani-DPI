# Data-Consistency Implementation Plan

Scope: the five fixes described in the task, grounded in the investigation report
(`.agents/tasks/chat-logs-alerts-investigation.md`) and confirmed against the actual code.
Target repo: `c:\Antigravity\Urbani DPI` (TypeScript monorepo — `@urbani/shared`,
`@urbani/backend`, `@urbani/frontend`). `INTEGRATION_MODE=live`.

## Decisions already fixed by the task (do not re-litigate)
- Correlate live alerts to live log lines; persist BOTH `alert_evidence` and `log_references.alert_id`.
- Derive a labeled confidence score for live alerts (chosen over honest-null).
- Make chat-vs-logs scope difference visible; surface a degraded Logs state and the chat grounding note.
- Alert detail: evidence empty-state + real `source` provenance.
- Clear seeded MOCK alerts when live sync is active.

## Design decisions made here (grounded in the code)

1. **Confidence "derived" signal — use the implicit rule, no schema/DB migration.**
   `packages/shared/src/alerts.ts` already types `confidence: z.number().min(0).max(1).nullable()`.
   The task permits either adding an optional `confidenceDerived` flag OR treating "a LIVE alert
   with non-null confidence" as implicitly derived. I choose the **implicit rule**: migrations are
   append-only and the DB column (`alerts.confidence REAL`) already round-trips cleanly, so adding a
   boolean column + migration + repository plumbing is more invasive than the honesty requirement
   needs. The UI already knows an alert's provenance (`res.source` / the Alerts list `source`), so
   "source is LIVE AND confidence is non-null" uniquely identifies a derived score. This rule is
   documented in a code comment in `HttpUrbaniAlertsAdapter.mapOne` and consumed by a new
   `derived` prop on the `Confidence` component. Rationale recorded per task guidance.

2. **Confidence value — derive from severity in `mapOne`, no evidence-count nudge.**
   `mapOne` runs at mapping time and does not have the correlated-log count (correlation happens
   later in `alertService.syncLiveAlerts`, Fix 1). Rather than thread the count back into the
   adapter (invasive, and the adapter is cached per-service), compute from severity alone, mirroring
   the mock's shape: CRITICAL 0.9, HIGH 0.8, MEDIUM 0.7, LOW 0.6. Clamp [0,1], round to 2 decimals.
   This is deterministic and keeps the adapter stateless. (The mock heuristic
   `Math.min(0.6 + errorLogs.length * 0.05, 0.95)` stays untouched.)

3. **Logs degraded signal — reuse the existing `AdapterMeta`/`Sourced` envelope.**
   `WithMeta<LogEntry[]>` (`packages/backend/src/integrations/types.ts`) already carries
   `meta.source: DataSource` + `meta.note`. The logs adapter currently hardcodes `source: 'LIVE'`
   in `getLogs`. I make `fetchService`/`fetchLatest`/`fetchHistory` report whether an upstream
   failure occurred (vs genuinely-empty), and when ALL targeted services failed with ZERO lines
   returned, `getLogs` emits `source: 'WAITING_FOR_INTEGRATION'` + a degraded note. A partial
   failure (some lines present) stays `LIVE`. `telemetryService.logs` already passes `res.meta.source`
   / `res.meta.note` straight into the `Sourced` envelope — no new response shape.

4. **Chat grounding note — thread it through as a new `ChatAnswer.groundingNote` field.**
   The provider already builds the note (`HttpUrbaniChatProvider.mapResponse` → `meta.note`) and
   `chatService` already receives it as `result.meta.note` and sets it as the envelope `sourceNote`.
   But the frontend `ChatAnswer` (`endpoints.ts`) and `useAssistantChat` read only `res.data.*`, not
   `res.sourceNote`, so the note never reaches a bubble. Add `groundingNote: string` to the backend
   `ChatAnswer` (`chatService.ts`) and the frontend `ChatAnswer` (`endpoints.ts`), populate it from
   `result.meta.note`, and render a one-line note under the assistant answer. This is less fragile
   than depending on the envelope `sourceNote` which the UI deliberately ignores.

---

# Verification commands (run from repo root unless noted)
- Build everything: `npm run build` (runs shared → backend → frontend in order).
- If `packages/shared/src` changes: `npm run build:shared` BEFORE building backend/frontend
  (shared is a dependency of both). This plan avoids shared changes, so this is only a safety note.
- Backend tests: `npm test` (vitest, currently 21/21 green). Must stay green and grow.
- Frontend typecheck: `npx tsc -b --noEmit` in `packages/frontend`.
- Do NOT start/stop dev servers (running with HMR).

---

# Implementation Plan

- [ ] 1. Add alert-correlation repository methods to `alertRepository` and `telemetryRepository`.
      In `alertRepository` add `replaceDerivedEvidence(alertId: string, lines: string[]): void` —
      inside one transaction, `DELETE FROM alert_evidence WHERE alert_id = ?` then insert the capped
      lines with sequential `ordinal` (reuse the `randomUUID()` + `INSERT INTO alert_evidence` pattern
      already in `insert`/`upsertLivePreservingStatus`), and `deleteByDataSource(source: DataSource): number`
      (`DELETE FROM alerts WHERE data_source = ?`, return `res.changes`; child rows cascade via
      `ON DELETE CASCADE` for evidence/actions and `ON DELETE SET NULL` for `log_references.alert_id`).
      In `telemetryRepository.logRepository` add `clearAlertLinks(alertId: string): void`
      (`UPDATE log_references SET alert_id = NULL WHERE alert_id = ?`) and
      `linkLogsToAlert(alertId: string, logIds: string[]): void` (set `alert_id = ?` for the matching
      ids in one transaction). Keep all SQL inside the repositories (no inline SQL in services).
      Files: `packages/backend/src/repositories/alertRepository.ts`,
      `packages/backend/src/repositories/telemetryRepository.ts`
      Verify: `npm test` — existing suites still pass (new methods are additive; covered by tests in step 8).

- [ ] 2. Derive a confidence score for live alerts in the alerts adapter.
      In `HttpUrbaniAlertsAdapter.mapOne` (`packages/backend/src/integrations/live/HttpUrbaniAlertsAdapter.ts`),
      replace `confidence: null` with a derived score from `severity` via a new private
      `deriveConfidence(severity: Severity): number` (CRITICAL 0.9 / HIGH 0.8 / MEDIUM 0.7 / LOW 0.6,
      clamped to [0,1], rounded to 2 decimals). Update the existing `// QA returns no confidence…`
      comment to document that the value is a DERIVED heuristic (not model-reported) and that the
      implicit rule "LIVE alert + non-null confidence ⇒ derived" is how the UI labels it (Decision 1).
      Leave `evidence: []` in the adapter unchanged (evidence is correlated later in step 3).
      Files: `packages/backend/src/integrations/live/HttpUrbaniAlertsAdapter.ts`
      Verify: `npm test` — update the adapter test expectation (step 8) that currently asserts
      `confidence` is null; run the adapter suite and confirm it passes.

- [ ] 3. Correlate live alerts to live log lines in `syncLiveAlerts`, idempotently.
      In `packages/backend/src/services/alertService.ts`, after the upsert loop in `syncLiveAlerts()`,
      add a correlation pass per upserted alert. Pull recent live logs via the cloudwatch adapter
      from `getIntegrations()` (`cloudwatch.getLogs({ service: alert.service, limit: 100 })`, use
      `.value`), then select matching lines with a new small module-local pure helper
      `matchEvidence(alert, logs): LogEntry[]` that is: same service; timestamp within a window around
      the alert ts (e.g. ±30 min; be defensive about unparseable timestamps); AND a keyword match
      (case-insensitive substring over `message`) built from the alert's `anomalyType`/`summary` —
      extract any HTTP status code via `/(?:HTTP[_-]?)?(\d{3})/i`, and test tokens like the status
      code, `anomalyType` words, `'error'`, `'timeout'`, `'403'`, `'database'`/`'connection'` when the
      anomaly mentions them. Keep it a heuristic; cap results at 10 (prefer newest). Then persist both
      ways and idempotently: `alertRepository.replaceDerivedEvidence(alert.alertId, matched.map(l => l.message))`
      and `logRepository.clearAlertLinks(alert.alertId)` followed by
      `logRepository.linkLogsToAlert(alert.alertId, matched.map(l => l.id))`. If no match, call the
      clear methods with an empty set so stale links are removed and evidence stays `[]` (never
      fabricate). Wrap the correlation in the existing try/catch so a correlation failure never 500s
      the Alerts page (log a warning, continue).
      NOTE on persistence: `log_references` rows exist for SEEDED logs; LIVE logs come from the adapter
      and are NOT persisted in `log_references`, so `linkLogsToAlert` only stamps ids that actually
      exist in the table. `AlertDetail.relatedLogs` is served by `logRepository.byAlert` (DB-backed),
      so correlation shows related logs only for ids present in `log_references`; `alert_evidence`
      (the message strings) is always populated for matched LIVE lines and is what the Evidence card
      renders. Document this in a comment so the two-table behavior is explicit.
      Files: `packages/backend/src/services/alertService.ts`
      Verify: `npm test` — new correlation tests (step 8) pass; existing alertService tests stay green.

- [ ] 4. Clear seeded MOCK alerts on effective live sync (Fix 5).
      In `syncLiveAlerts()` (`packages/backend/src/services/alertService.ts`), guarded by the existing
      `liveConfigured()` check (already the first line of the function) and only after a SUCCESSFUL
      fetch of live alerts, call `alertRepository.deleteByDataSource('MOCK')` once per sync BEFORE (or
      right after) the upsert loop. Do it inside the existing `try` so a failed live fetch leaves MOCK
      rows untouched (never strand the Alerts page empty on a transient upstream error). Never delete
      LIVE rows. `upsertLivePreservingStatus` continues to preserve acknowledge/resolve status.
      Files: `packages/backend/src/services/alertService.ts`
      Verify: `npm test` — a new test (step 8) asserts MOCK rows are removed and LIVE rows survive a
      sync; `acknowledge` of a LIVE alert still works.

- [ ] 5. Surface a degraded Logs state from the live logs adapter (Fix 3, logs half).
      In `packages/backend/src/integrations/live/HttpUrbaniLogsAdapter.ts`, track upstream failure vs
      genuine-empty. Change `onFailure` to signal failure to the caller (e.g. return a sentinel or set
      a per-call failure flag), have `fetchLatest`/`fetchHistory`/`fetchService` propagate a
      `{ tuples, failed }` shape, and in `getLogs` compute: if the merged result has zero lines AND
      every targeted service's fetch failed upstream, return
      `meta: { source: 'WAITING_FOR_INTEGRATION', note: 'Live Urbani logs temporarily unavailable (upstream fetch failed).' }`;
      otherwise keep the existing `source: 'LIVE'` note. A genuinely-empty-but-successful window stays
      `LIVE` with an empty `value`. Preserve the stale-cache behavior (serving cache is a success, not a
      failure). Keep the API key out of all notes/logs.
      Files: `packages/backend/src/integrations/live/HttpUrbaniLogsAdapter.ts`
      Verify: `npm test` — extend the logs adapter suite (step 8) to assert `WAITING_FOR_INTEGRATION`
      on all-fail/empty and `LIVE` on success/partial; run it and confirm green.

- [ ] 6. Render the degraded Logs message and keep the empty-state (Fix 3, Logs page).
      In `packages/frontend/src/pages/Logs.tsx`, when `logs.data?.source === 'WAITING_FOR_INTEGRATION'`
      (and items are empty), render a degraded note ("Live logs temporarily unavailable — showing the
      last available window.") instead of the bare "No log entries match these filters." Keep the
      normal empty-state for a truly empty LIVE/MOCK window. The `PageHeader` already shows the
      `source` badge via `logs.data?.source`, so provenance stays honest automatically.
      Files: `packages/frontend/src/pages/Logs.tsx`
      Verify: `npx tsc -b --noEmit` in `packages/frontend` passes; visually (HMR) the Logs page shows
      the degraded note when source is WAITING_FOR_INTEGRATION.

- [ ] 7. Thread the chat grounding note to the UI (Fix 3, chat half).
      Backend: add `groundingNote: string` to the `ChatAnswer` interface in
      `packages/backend/src/services/chatService.ts` and set it from `result.meta.note` in the returned
      `data` object (the provider already computes the "grounded server-side in N windows and M
      alerts" note). Frontend: add `groundingNote: string` to the `ChatAnswer` interface in
      `packages/frontend/src/api/endpoints.ts`; in
      `packages/frontend/src/components/assistant/useAssistantChat.tsx` carry `res.data.groundingNote`
      onto the assistant message (append to the existing `meta` string, or add a dedicated field on
      `AssistantMessageData`); in `packages/frontend/src/components/assistant/AssistantMessage.tsx`
      render that one-line note under the answer (reuse the existing `.chat-meta` block). Keep it short
      and honest — it clarifies the answer may draw on ALERTS, not just the filtered log window. Do not
      break the existing `source` badge or `provider · modelId` meta.
      Files: `packages/backend/src/services/chatService.ts`,
      `packages/frontend/src/api/endpoints.ts`,
      `packages/frontend/src/components/assistant/useAssistantChat.tsx`,
      `packages/frontend/src/components/assistant/AssistantMessage.tsx`
      Verify: `npm test` (backend chatService/provider tests still green) and
      `npx tsc -b --noEmit` in `packages/frontend` passes.

- [ ] 8. Alert detail: evidence empty-state + real provenance (Fix 4) and the derived-confidence label (Fix 2 UI).
      In `packages/frontend/src/components/ui.tsx`, extend `Confidence` with an optional
      `derived?: boolean` prop: when `value != null && derived`, render the percentage plus a small
      "derived" affordance (a muted suffix label or a `title` tooltip, e.g. "Derived from severity —
      not a model-reported score"); keep the `—` render for null untouched. In
      `packages/frontend/src/pages/Alerts.tsx` pass `derived={al.confidence != null && alerts.data?.source === 'LIVE'}`
      to the table `<Confidence>`. In `packages/frontend/src/pages/AlertDetail.tsx`:
      (a) change the hardcoded `source="MOCK"` on `PageHeader` to `source={res.source}`;
      (b) pass `derived={a.confidence != null && res.source === 'LIVE'}` to the confidence card's
      `<Confidence>`; (c) add an evidence empty-state — when `a.evidence.length === 0`, render
      `<p className="text-secondary">No log evidence correlated for this incident.</p>` mirroring the
      "No related logs linked." pattern, else render the existing mapped lines.
      Files: `packages/frontend/src/components/ui.tsx`,
      `packages/frontend/src/pages/Alerts.tsx`,
      `packages/frontend/src/pages/AlertDetail.tsx`
      Verify: `npx tsc -b --noEmit` in `packages/frontend` passes; (HMR) a LIVE alert shows a LIVE
      badge, a derived-labeled confidence, and the evidence empty-state when uncorrelated.

- [ ] 9. Backend tests for the new behavior.
      Add/extend vitest suites using the `freshTestDb()` helper (`packages/backend/src/test/testDb.ts`)
      and the existing patterns in `alertService.test.ts` and the adapter `*.test.ts` files:
      - `alertRepository`/`telemetryRepository`: `replaceDerivedEvidence` replaces (idempotent) and caps;
        `deleteByDataSource('MOCK')` removes MOCK rows, leaves LIVE rows, and cascades child rows;
        `clearAlertLinks` + `linkLogsToAlert` set/clear `log_references.alert_id` so `byAlert` returns
        the linked rows. (Seed a few `log_references` rows directly via the test DB.)
      - `HttpUrbaniAlertsAdapter.test.ts`: update the existing confidence assertion — a mapped LIVE
        alert now has a non-null derived confidence matching the severity table (e.g. MEDIUM → 0.7).
      - `HttpUrbaniLogsAdapter.test.ts`: mock `fetch` to fail for all services → `getLogs` meta.source
        is `WAITING_FOR_INTEGRATION` with empty value; a successful-but-empty window stays `LIVE`; a
        partial success stays `LIVE`.
      - `alertService.test.ts`: a correlation test — seed `log_references` for a service, drive the
        correlation primitives (as the existing test drives `upsertLivePreservingStatus` directly,
        since `syncLiveAlerts` is config-gated in mock-mode tests) and assert `alert_evidence` and
        `byAlert` are populated for matching lines and empty for non-matching; re-running is idempotent
        (no duplicate evidence/links).
      - `chatService`: assert the returned `data.groundingNote` is populated from the provider note
        (follow the mock-provider wiring used by existing chat/provider tests).
      Files: `packages/backend/src/repositories/*.test.ts` (new as needed),
      `packages/backend/src/integrations/live/HttpUrbaniAlertsAdapter.test.ts`,
      `packages/backend/src/integrations/live/HttpUrbaniLogsAdapter.test.ts`,
      `packages/backend/src/services/alertService.test.ts`
      Verify: `npm test` — all suites green (21 existing + new).

- [ ] 10. Full build and typecheck gate.
      Run the project's real build/test/typecheck end-to-end and fix any fallout.
      Files: none (verification only)
      Verify: `npm run build` succeeds (shared → backend → frontend); `npm test` green at repo root;
      `npx tsc -b --noEmit` passes in `packages/frontend`.

---

# Notes / assumptions
- No `packages/shared/src` change is required (confidence stays `number|null`; the "derived" signal is
  the implicit LIVE+non-null rule). If a later reviewer insists on an explicit `confidenceDerived`
  flag, it would mean: shared schema field → `rowToAlert`/`insert`/`upsert` plumbing + a new DB column
  (append-only migration `002_*.sql`) → API passthrough → frontend prop. That is deliberately out of
  scope here per Decision 1; the implicit rule is documented in code.
- LIVE logs are not persisted to `log_references`; only seeded logs are. So `linkLogsToAlert` is a
  no-op for ids absent from the table, and `AlertDetail.relatedLogs` populates only for persisted
  (seeded) log rows, while `alert_evidence` (message strings) always populates for matched LIVE lines.
  This is called out in the step-3 code comment so the two-table behavior is not mistaken for a bug.
- Order rationale: step 1 (repo methods) precedes steps 3–4 (services that call them); step 2 (adapter
  confidence) precedes step 8 (UI label) and step 9 (adapter test update); steps 5/7 (backend) precede
  6/7-frontend rendering; step 10 is the final gate. Each step leaves the tree buildable.
