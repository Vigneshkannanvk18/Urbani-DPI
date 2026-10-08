# Data-Consistency Fixes — Verification Note

First iteration (no `data-consistency-review.json` present). All five fixes implemented
per `data-consistency-plan.md`.

## Commands run (repo root unless noted)

- `npm test` (backend vitest) — **62 passed / 62** (was 21; +41 from new/expanded suites).
- `npm run build` — **succeeded** for `@urbani/shared`, `@urbani/backend`, `@urbani/frontend`.
- `npx tsc -b --noEmit` in `packages/frontend` — **clean (exit 0)**.

No shared schema change was required, so `build:shared` is covered by the normal build order.
Dev servers were NOT started/stopped. No `.env` secrets were touched.

## Files changed

Backend:
- `src/repositories/alertRepository.ts` — added `replaceDerivedEvidence(alertId, lines)`
  (idempotent evidence replace) and `deleteByDataSource(source)` (returns rows removed).
- `src/repositories/telemetryRepository.ts` — added `logRepository.clearAlertLinks(alertId)`
  and `logRepository.linkLogsToAlert(alertId, logIds)`.
- `src/integrations/live/HttpUrbaniAlertsAdapter.ts` — `mapOne` now populates a DERIVED
  confidence via `deriveConfidence(severity)` (CRITICAL 0.9 / HIGH 0.8 / MEDIUM 0.7 / LOW 0.6,
  clamped+rounded) instead of `null`; documents the implicit "LIVE + non-null ⇒ derived" rule.
- `src/services/alertService.ts` — exported pure `matchEvidence(alert, logs)` heuristic
  (same-service + ±30 min window + keyword/HTTP-status token match, cap 10 newest, no
  fabrication); `syncLiveAlerts()` now (a) clears seeded MOCK alerts after a successful live
  fetch (`deleteByDataSource('MOCK')`), and (b) correlates each live alert to recent live logs,
  persisting matched message strings to `alert_evidence` and stamping `log_references.alert_id`,
  idempotently (clear+replace). Correlation is wrapped so a failure never 500s the page.
- `src/integrations/live/HttpUrbaniLogsAdapter.ts` — distinguishes upstream failure from a
  genuinely-empty window via a `ServiceFetch { tuples, failed }` shape threaded through
  `fetchLatest`/`fetchHistory`/`fetchService`/`onFailure`; `getLogs` emits
  `source: WAITING_FOR_INTEGRATION` only when ALL targeted services failed AND zero lines
  returned (partial success / empty-success / stale-cache stay `LIVE`).
- `src/services/chatService.ts` — added `groundingNote` to `ChatAnswer`, populated from
  `result.meta.note`.

Frontend:
- `src/api/endpoints.ts` — added `groundingNote: string` to the `ChatAnswer` interface.
- `src/components/assistant/useAssistantChat.tsx` — added `groundingNote` to
  `AssistantMessageData` and carried `res.data.groundingNote` onto the assistant message.
- `src/components/assistant/AssistantMessage.tsx` — renders the grounding note as a one-line
  `.chat-meta` under non-error assistant answers.
- `src/components/ui.tsx` — `Confidence` gained an optional `derived` prop (adds a muted
  "(derived)" suffix + explanatory tooltip; null still renders `—`).
- `src/pages/Alerts.tsx` — passes `derived={al.confidence != null && a.source === 'LIVE'}`.
- `src/pages/AlertDetail.tsx` — `PageHeader` now uses `source={res.source}` (was hardcoded
  MOCK); confidence card passes `derived`; Evidence card shows an explicit empty-state
  ("No log evidence correlated for this incident.").
- `src/pages/Logs.tsx` — shows "Live logs temporarily unavailable…" when
  `source === 'WAITING_FOR_INTEGRATION'` and the window is empty; keeps the normal empty-state
  otherwise.

## Tests added / updated

- `src/repositories/alertCorrelation.test.ts` (NEW, 5 cases) — evidence replace/idempotent/clear;
  `deleteByDataSource` removes MOCK, keeps LIVE, cascades evidence and nulls `log_references.alert_id`;
  link/clear related logs; link is a no-op for ids absent from `log_references`.
- `src/services/chatService.test.ts` (NEW, 1 case) — provider note surfaces on `data.groundingNote`.
- `src/services/alertService.test.ts` (UPDATED) — added a `matchEvidence` describe block (6 cases:
  status-token match, keyword match, wrong-service reject, out-of-window reject, no-match returns
  [], cap-at-10 newest-first).
- `src/integrations/live/HttpUrbaniAlertsAdapter.test.ts` (UPDATED) — confidence is now the derived
  value (MEDIUM→0.7, HIGH→0.8) instead of null.
- `src/integrations/live/HttpUrbaniLogsAdapter.test.ts` (UPDATED) — the all-fail/empty case now
  asserts `WAITING_FOR_INTEGRATION`; added empty-success-stays-LIVE and partial-success-stays-LIVE.

## Honesty / provenance notes

- Derived confidence is never presented as model-reported: labelled "(derived)" with a tooltip,
  and the implicit "LIVE + non-null ⇒ derived" rule is documented in the adapter.
- Log evidence is only ever matched real lines; no fabrication (empty when nothing matches).
- Degraded logs are labelled `WAITING_FOR_INTEGRATION`, not silently empty.
