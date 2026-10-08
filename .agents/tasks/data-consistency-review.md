# Data-consistency fixes: alert↔log correlation, derived confidence, degraded-logs signal

This change reconciles the three live data paths the investigation flagged. Live alerts are now correlated to recent live log lines (persisted both as `alert_evidence` message strings and as `log_references.alert_id` stamps, idempotently), live alerts get a confidence score derived from severity instead of a bare `null`, the logs adapter distinguishes an upstream fetch failure from a genuinely-empty window, the chat UI surfaces the server-side grounding note, and seeded MOCK alerts are cleared once a live sync succeeds. The derived confidence is honestly labelled "(derived)" in the UI via the implicit "LIVE + non-null ⇒ derived" rule, and no log lines are ever fabricated — an empty match clears evidence rather than inventing it.

Watch for: a stale/incorrect comment in `HttpUrbaniAlertsAdapter` and `deriveConfidence` claiming `alertService` "nudges up" / "refines" the confidence after correlation — no such refinement exists in the code (confirmed). Also note the correlation pass issues a second round of `cloudwatch.getLogs` per distinct service on every alert list/get/acknowledge, roughly doubling upstream log calls on the alerts path (confirmed). Both are non-blocking.

**Verdict**: APPROVED

## High-level view

The correlation is the center of gravity. `syncLiveAlerts` now deletes MOCK rows after a successful live fetch, upserts the live alerts, then runs `correlateLiveAlerts`, which fetches recent logs once per distinct service and, per alert, replaces derived evidence and clears-then-relinks `log_references.alert_id`. Both persistence paths are idempotent by construction (delete-then-insert, clear-then-link), so repeated syncs don't accumulate duplicates. The whole correlation is wrapped so a failure degrades to a warning rather than a 500. The two-table split is deliberate and documented: `alert_evidence` always carries matched LIVE message strings, while `log_references.alert_id` only stamps ids that already exist (seeded rows), because LIVE adapter logs aren't persisted there.

Confidence is derived from severity alone in `mapOne` (CRITICAL 0.9 / HIGH 0.8 / MEDIUM 0.7 / LOW 0.6), matching the plan's Decision 2 of no evidence-count nudge. The honesty affordance is the implicit rule: the UI treats a LIVE alert with non-null confidence as derived and renders a muted "(derived)" suffix plus an explanatory tooltip; genuinely-null values still render `—`. No shared-schema flag was added, consistent with the plan.

The logs degraded signal threads a `{ tuples, failed }` shape through `fetchLatest`/`fetchHistory`/`fetchService`/`onFailure`. `getLogs` emits `WAITING_FOR_INTEGRATION` only when every targeted service failed upstream AND zero lines came back; partial success, empty-success, and stale-cache all keep the honest `LIVE` label.

The chat grounding note is carried end-to-end as a new `groundingNote` field on both the backend and frontend `ChatAnswer`, populated from the provider's `meta.note`, and rendered as a one-line `.chat-meta` under non-error answers. Provenance stays correct throughout: `AlertDetail` now uses `res.source` instead of the hardcoded `MOCK`, and the SourceBadge/degraded-logs semantics are preserved.

Verification evidence is present and credible: the coder recorded `npm test` 62/62 (up from the 21 baseline), `npm run build` green across all three packages, and `npx tsc -b --noEmit` clean in the frontend. The new/updated suites cover idempotency, MOCK-cleanup cascade, the degraded-vs-empty distinction, the matchEvidence heuristic, and the groundingNote flow.

<details>
<summary>Issues (4)</summary>

1. **Stale "refines confidence" comment** — the `mapOne` block comment and `deriveConfidence` JSDoc in `HttpUrbaniAlertsAdapter` claim `alertService` nudges/refines the confidence after correlation, but no such code exists. Trim the comment to describe severity-only derivation. Non-blocking.
2. **Doubled upstream log calls on the alerts path** — `correlateLiveAlerts` re-fetches `cloudwatch.getLogs` per distinct service on every alert list/get/acknowledge, in addition to the Logs page's own fetches. Acceptable given the adapter's TTL cache, but worth a note. Non-blocking.
3. **CRITICAL confidence renders green** — derived CRITICAL = 0.9 → 90% → success/green in `Confidence`, which can read oddly next to a CRITICAL severity badge. Cosmetic; confidence color is independent of severity by design. Non-blocking.
4. **Logs degraded note wording vs empty cache** — the note says "showing the last available window," but the degraded branch only fires when `items.length === 0`, so there's nothing to show. Consider "no recent window available." Non-blocking copy nit.

</details>

<details>
<summary>Details</summary>

### Correlation: idempotency and the two-table split

`correlateLiveAlerts` fetches recent logs once per distinct service (deduped via a `Set`), then for each alert computes `matchEvidence`, calls `replaceDerivedEvidence` (delete-all-then-insert on `alert_evidence`), and `clearAlertLinks` followed by `linkLogsToAlert`. Both persistence operations are idempotent: re-running a sync replaces evidence wholesale and clears links before re-stamping, so no duplicate rows accumulate. The `alertCorrelation.test.ts` suite confirms this directly — `replaceDerivedEvidence` with new lines replaces rather than appends, and an empty array clears without fabricating.

The two-table behavior is the subtle part, and it's documented in the code. LIVE adapter logs are never written to `log_references`, so `linkLogsToAlert` is a no-op for LIVE ids — the test "linkLogsToAlert is a no-op for ids absent from log_references" pins this. The practical consequence: the Evidence card (driven by `alert_evidence` message strings) populates for matched LIVE lines, while the Related Logs card (driven by `byAlert` / `log_references.alert_id`) populates only for seeded rows. This matches the investigation's finding and the plan's note; it's intentional, not a gap.

Failure isolation holds at three levels: the per-service fetch falls back to `[]`, each alert's correlation logs a warning and continues, and the whole `syncLiveAlerts` body sits inside the existing try/catch. A correlation failure cannot 500 the Alerts page.

### MOCK cleanup placement and ordering

`deleteByDataSource('MOCK')` runs inside the `try`, after the live fetch resolves and before the upsert loop. Placement matters for the failure mode: a failed upstream fetch throws before the delete, so MOCK rows survive a transient outage rather than stranding the page empty. The filter is `data_source = 'MOCK'`, so LIVE rows are never touched — the test confirms LIVE survives while MOCK is removed. Child rows cascade (`alert_evidence`/`alert_recommended_actions` via `ON DELETE CASCADE`, `log_references.alert_id` via `ON DELETE SET NULL`), verified by the two cascade tests.

### Derived confidence and the honesty label

`deriveConfidence` maps severity to a fixed score, matching Decision 2 (no evidence-count nudge). The UI never presents this as model-reported: `Confidence` renders a muted "(derived)" suffix and a tooltip, with the `derived` flag computed as `confidence != null && source === 'LIVE'` in both the Alerts table and AlertDetail; genuinely-null confidence still renders `—`.

The one real defect here is comment accuracy. The `mapOne` comment says "alertService may refine this value after log correlation (more matched evidence => slightly higher)" and `deriveConfidence`'s JSDoc says "alertService nudges it up after correlation." Grepping `confidence` in `alertService.ts` returns nothing — there is no refinement. The comments describe a behavior that was explicitly rejected in the plan. The code is correct; the comments are misleading and should be trimmed to severity-only derivation. The tooltip in `ui.tsx` ("Derived from severity and matched log evidence…") inherits the same slight overstatement, since matched evidence does not actually influence the score.

### Degraded-vs-empty logs distinction

`failed` is true only when an upstream call errored with no cache to serve, so a stale-cache hit stays `failed=false` — a degraded label is reserved for genuine upstream loss, not a cache serve. `getLogs` gates `WAITING_FOR_INTEGRATION` on `allFailed && items.length === 0`, with the partial-success test driving one service to a line and another to a 500 and asserting `LIVE`. The API key is kept out of the degraded note and the serialized result (asserted via `not.toContain(KEY)`).

One copy nit: the frontend degraded message reads "Live logs temporarily unavailable — showing the last available window," but this branch only renders when `items.length === 0`, i.e. there is no window to show. "No recent window available" would be more accurate. Cosmetic.

### Chat grounding note flow

The note is carried end-to-end from `result.meta.note` onto `AssistantMessageData.groundingNote` and rendered as a `.chat-meta` line gated on `groundingNote && !isError`, leaving the existing `provider · modelId` meta and source badge untouched. `chatService.test.ts` asserts both that `data.groundingNote` carries the provider note and that the envelope `sourceNote` still carries it — so the new field didn't regress the pre-existing envelope path.

### Test coverage

New and updated suites raise the count from 21 to 62. Covered: evidence replace/idempotency/clear, `deleteByDataSource` MOCK-removal with both cascade paths, link/clear-link round-trips, the no-op-for-absent-id case, the `matchEvidence` heuristic (status token, keyword, wrong-service reject, out-of-window reject, no-match-returns-[], cap-at-10 newest-first), the three logs degraded/LIVE branches, the derived-confidence adapter assertions, and the groundingNote flow.

Not tested: `correlateLiveAlerts` end-to-end (the orchestration that wires `matchEvidence` + the repo primitives + the per-service fetch together) is not driven directly — the pieces are tested in isolation. This mirrors the existing pattern (the plan notes `syncLiveAlerts` is config-gated in mock-mode tests), so it's a reasonable seam, but the integration glue itself is unverified by an automated test. The doubled-fetch behavior on the alerts path is also not asserted.

### Pattern conformance

All new SQL lives in `alertRepository`/`telemetryRepository` — no inline SQL leaked into services — and the `Sourced<T>`/`AdapterMeta` envelope is reused rather than reshaped. The implicit-rule decision avoided a shared-schema change: the derived-confidence value round-trips through the existing `REAL` column with no migration, consistent with the plan's append-only-migrations rationale.

</details>

<details>
<summary>File map</summary>

- `packages/backend/src/integrations/live/HttpUrbaniAlertsAdapter.ts` — derived confidence from severity; stale "refines" comment.
- `packages/backend/src/integrations/live/HttpUrbaniLogsAdapter.ts` — `{tuples, failed}` shape; `WAITING_FOR_INTEGRATION` on all-fail-empty.
- `packages/backend/src/repositories/alertRepository.ts` — `replaceDerivedEvidence`, `deleteByDataSource`.
- `packages/backend/src/repositories/telemetryRepository.ts` — `clearAlertLinks`, `linkLogsToAlert`.
- `packages/backend/src/services/alertService.ts` — `matchEvidence` helper; MOCK cleanup + `correlateLiveAlerts` in `syncLiveAlerts`.
- `packages/backend/src/services/chatService.ts` — `groundingNote` on `ChatAnswer`.
- `packages/frontend/src/api/endpoints.ts` — `groundingNote` field.
- `packages/frontend/src/components/assistant/{useAssistantChat,AssistantMessage}.tsx` — carry + render grounding note.
- `packages/frontend/src/components/ui.tsx` — `Confidence` `derived` prop.
- `packages/frontend/src/pages/{Alerts,AlertDetail,Logs}.tsx` — derived label, real source, evidence empty-state, degraded-logs note.
- Tests: `alertCorrelation.test.ts` (new), `chatService.test.ts` (new), `alertService.test.ts`, `HttpUrbaniAlertsAdapter.test.ts`, `HttpUrbaniLogsAdapter.test.ts`.

Full diff: `git diff main`.

</details>
