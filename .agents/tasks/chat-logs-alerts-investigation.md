# Chat vs Logs vs Alerts — Data-Consistency Investigation

Read-only investigation of the four UI symptoms in the Urbani DPI observability app
(`c:\Antigravity\Urbani DPI`). Backend: Express + SQLite under `packages/backend/src`.
Frontend: React/Vite under `packages/frontend/src`. `INTEGRATION_MODE=live`
(`packages/backend/.env`). No code was changed.

---

## Summary answer (TL;DR)

All four symptoms are **real and explained by the live integration contract**, not by a
single bug. The common root cause is that the app wires **three independent live data
paths** that each fetch from the Urbani QA API Gateway separately, and the QA API returns
**sparse alert objects** (no confidence, no evidence lines):

| # | Symptom | Root cause |
|---|---------|-----------|
| A | Chatbot answers about PAYMENTS 403 errors but Logs page shows none | Chat and Logs use **different live endpoints**. Chat = `POST /chat` (QA grounds *server-side* across logs **and alerts**, all services). Logs = `GET /logs/latest` + `/logs/history` per selected service. The chat answer is **not** derived from the lines the Logs page shows; the two windows legitimately disagree. The MockAIProvider "payments 403" canned text theory is **false** — in live mode `MockAIProvider.askLogs` is never called for chat. |
| B | Alerts for main+payments with no backing log evidence | Live alerts come from `GET /alerts/latest` + `/alerts/history` and are mapped with **`evidence: []`** (QA returns no evidence lines). There is **no linkage** between a live alert and any log row — `log_references.alert_id` is never populated for live data. |
| C | CONFIDENCE column shows `—` for every row | `HttpUrbaniAlertsAdapter.mapOne` hard-sets **`confidence: null`** (QA returns no score). `Confidence` component renders `—` when the value is null. The field exists end-to-end; it is simply always null for LIVE alerts. |
| D | Alert detail missing log evidence | Same as B — `evidence` is `[]` and `relatedLogs` is empty because no `log_references` row carries the alert's `alert_id`. Confidence card also shows `—`. |

The deeper disagreement in A/B is a **cross-source grounding mismatch**: `POST /chat` is
grounded by QA on a server-side corpus (recent log windows + alerts for the service it
decides), while the Logs page renders only the client-selected service's merged
latest+history window. They are two different queries against two different endpoints, so
"chat says payments 403 / logs page shows nothing" is expected given the current design.

---

## A. CHAT vs LOGS data-source divergence

### A.1 — Which provider actually answers chat in live mode

`INTEGRATION_MODE=live` + a configured Urbani API means the chat provider is
**`HttpUrbaniChatProvider`**, not `MockAIProvider`.

`packages/backend/src/integrations/index.ts` (buildLive, ~L72-104):

```ts
base.aiProvider = new HttpUrbaniChatProvider(
  config.urbani.apiBaseUrl!, config.urbani.apiKey!, config.urbani.service,
  config.urbani.chatModelId, config.urbani.chatTimeoutMs,
);
```

So the theory that `MockAIProvider.askLogs` emits hardcoded "payments 403" text is
**ruled out**. Reviewed `packages/backend/src/integrations/ai/MockAIProvider.ts`
`askLogs` (~L136-205): it is fully evidence-derived — it filters the passed-in `input.logs`,
builds counts/citations from them, and with an empty window returns the honest
"no logs in the current window" message. There is **no canned payments/403 string anywhere**.
(The mock is only used for `analyzeTelemetry` delegation; see
`HttpUrbaniChatProvider.analyzeTelemetry` ~L78-80.)

### A.2 — What window the chatbot grounds on

`packages/backend/src/services/chatService.ts` (`ask`, ~L31-73):

- Service gating (~L39-42): the service is accepted only if it is in
  `config.urbani.services`, else falls back to `config.urbani.service` (`main`).
- It fetches a **local** log window `cloudwatch.getLogs({ service, limit: 100 })`
  (~L52), but on any failure it degrades to an **empty window** and still calls the provider
  (~L54-62). The comment is explicit: *"the live /chat endpoint grounds server-side on its
  own window anyway, so we degrade to an empty local window"*.
- The provider call passes `logs: logsRes.value` (~L66), but `HttpUrbaniChatProvider.askLogs`
  **ignores those lines entirely** — it POSTs only `{ service, question }` to `{base}/chat`
  (`HttpUrbaniChatProvider.ts` ~L108-120) and lets QA ground server-side.

`HttpUrbaniChatProvider.mapResponse` (~L150-190) builds the grounding note from a **counts
object** the QA API returns:

```ts
const nWindows = Number(body.evidence?.log_windows) || 0;
const nAlerts  = Number(body.evidence?.alerts) || 0;
// note: "...grounded server-side in N recent log window(s) and M alert(s)."
citations: [], // QA returns counts, not lines — never fabricate citations
```

So the chat answer is grounded in **recent log windows + alerts** chosen by QA, and crucially
**mixes alerts into the grounding corpus**. That is why chat can describe a "payments HTTP 403
medium-severity" incident — QA is almost certainly surfacing it from the **alerts** side of
its server-side context, not from the log lines the Logs page fetches.

### A.3 — How logs are fetched for the Logs page (`GET /logs`)

`packages/backend/src/services/telemetryService.ts` (`logs`, ~L28-50) calls
`cloudwatch.getLogs({ service, environment, level, search, limit: 100 })` and paginates
in-memory.

`packages/backend/src/integrations/live/HttpUrbaniLogsAdapter.ts` (`getLogs`, ~L120-158):

- If a `service` filter is given and enabled, it fetches **only that service**
  (~L122-124); otherwise it fans out across all `services`.
- Per service it merges `GET /logs/latest?service=` ∪ `GET /logs/history?service=&limit=20`
  (`fetchService` ~L164-178, `fetchLatest` ~L180-196, `fetchHistory` ~L198-222), de-dups,
  sorts newest-first, caps at 100, and applies the `service`/`level`/`search` filters.
- On any upstream non-200/timeout it **degrades to stale cache or `[]`** and never throws
  (`onFailure` ~L232-248). So an expired key / 403 on `/logs/*` yields an **empty** Logs page
  with no error — exactly "No log entries match these filters".

### A.4 — Does `payments` return log data?

The adapter *does* fetch per service and *does* request `payments`
(`URBANI_SERVICES=main,payments` in `packages/backend/.env`). Whether `payments` returns rows
depends entirely on the live QA API response, which this read-only investigation cannot call.
Two code-level facts make an **empty** payments window likely and benign:

1. `onFailure` silently returns `[]` for any non-200 (including 403) — no surfaced error.
2. The frontend defaults the chat service to `main`
   (`packages/frontend/src/components/assistant/useAssistantChat.tsx` ~L52:
   `useState('main')`), and the Logs page filters to a single service at a time, so even if
   `payments` had rows the user may be viewing `main`.

### A.5 — Why chat claims payments 403 while logs show none (conclusion)

Not a data-corruption bug. It is a **grounding-source mismatch**:

- Chat = `POST /chat`, grounded by QA across **log windows + alerts** (counts prove alerts are
  in the corpus), service chosen server-side; returns prose with **no citations**.
- Logs page = per-service `latest ∪ history` **log lines only**, degrading to `[]` on failure.

The chat is almost certainly echoing a **payments alert** (which does exist upstream — see
section B) that has **no corresponding log line** in the Logs window. The two views are
answering two different questions against two different endpoints.

**Recommended fix (A):** make the disagreement visible and reconcilable rather than silent:
1. In `HttpUrbaniLogsAdapter.getLogs`, when a per-service fetch returns `[]` *because* of an
   upstream failure (distinguish failure from genuinely-empty in `onFailure`), surface a
   `WAITING_FOR_INTEGRATION`/degraded meta note so the Logs page can show "live logs
   temporarily unavailable" instead of a bare "No entries".
2. Have the chat response echo the QA grounding counts to the UI (it already computes
   `nWindows`/`nAlerts` in the note) and label clearly that the answer may draw on **alerts**,
   not just the currently-filtered log window, so chat and Logs are understood as different
   scopes.
3. Optionally fetch `payments` into the Logs default view (or add an "all services" option) so
   a payments-grounded chat answer has a place to be cross-checked.

---

## B. ALERTS vs LOG EVIDENCE

### B.1 — Where alerts come from

Two sources, both routed through SQLite via `alertRepository`:

- **Seeded MOCK alerts** — `packages/backend/src/db/seed.ts` (~L96-99) loops
  `mockAlerts` and calls `alertRepository.insert(a, 'MOCK', 'OPEN')`. Seed is a **manual
  operator step** (`server.ts` ~L8-16 runs migrations only, never seed), so these rows persist
  until a reset.
- **Live alerts** — in live mode `alertService.list/get/acknowledge` first call
  `syncLiveAlerts()` (`packages/backend/src/services/alertService.ts` ~L38-57), which pulls
  `urbaniAlerts.getLatest()` + `getHistory(config.urbani.alertsHistoryLimit)` and upserts each
  via `alertRepository.upsertLivePreservingStatus` (data_source `LIVE`).

So the Alerts page can show **both** stale seeded MOCK alerts *and* freshly-synced LIVE
alerts, because the sync adds rows and never deletes the seeded ones. This explains the
mixed main/payments list in the screenshots (seeded main alerts + live payments/main alerts).

### B.2 — Are alert services/anomalies independent of actual logs?

Yes, for both sources:

- **Live:** `HttpUrbaniAlertsAdapter.mapOne`
  (`packages/backend/src/integrations/live/HttpUrbaniAlertsAdapter.ts` ~L178-205) maps the
  flat QA alert object and hard-sets:

  ```ts
  evidence: [],              // "QA does not return evidence lines — never fabricate."
  confidence: null,          // "QA returns no confidence score — honest 'unknown' (rendered '—')."
  recommendedActions: recommendation ? [recommendation] : [],
  ```

  The alert's `service`/`anomalyType`/`severity` come straight from QA
  (`service_id`, `anomaly_type`, `severity`) and are **not** correlated to any log row the app
  holds.

- **Seeded MOCK:** `mockAlerts`
  (`packages/backend/src/integrations/mock/mockData.ts` ~L76-137) *do* contain evidence
  strings and confidence (0.92 / 0.81 / 0.68), but those evidence strings are **free-text
  copies**, not foreign keys to `log_references`.

### B.3 — Is there any alert↔log linkage?

The schema **supports** it but it is **never populated**:

- `packages/backend/src/db/migrations/001_initial_schema.sql`:
  - `log_references.alert_id TEXT REFERENCES alerts(alert_id) ON DELETE SET NULL` (~L102,
    comment: *"related-logs link"*).
  - `metric_snapshots.alert_id` (~L122) and `ai_analyses.alert_id` (~L131) similarly.
- The seed's log insert
  (`seed.ts` ~L108-113) inserts into `log_references` **without an `alert_id` column**, so every
  seeded log row has `alert_id = NULL`.
- `telemetryRepository.byAlert(alertId)`
  (`packages/backend/src/repositories/telemetryRepository.ts` ~L97-106) selects
  `WHERE alert_id = ?` — which matches **nothing**, so `relatedLogs` is always `[]`.
- `alertRepository.rowToAlert` (~L58-90) loads `relatedLogIds` from
  `SELECT id FROM log_references WHERE alert_id = ?` — also always empty.

### B.4 — Alert schema & confidence field

`001_initial_schema.sql`, `CREATE TABLE alerts` (~L55-76) includes:

```
alert_id TEXT PRIMARY KEY, timestamp, service, environment, severity, anomaly_type,
summary, probable_cause, confidence REAL,  -- 0.0..1.0
model_id, status DEFAULT 'OPEN', acknowledged_by, acknowledged_at, data_source, created_at
```

Plus child tables `alert_evidence(alert_id, ordinal, line)` and
`alert_recommended_actions(alert_id, ordinal, action)`. A `confidence` column **exists**; it
is simply written as `NULL` for every LIVE alert.

**Recommended fix (B):** give LIVE alerts real log backing:
1. In `syncLiveAlerts` (or a follow-up step), correlate each live alert with recent live log
   lines (same service, timestamp window, matching `anomalyType`/HTTP-status keyword) and
   either (a) write those lines into `alert_evidence`, or (b) stamp matching
   `log_references.alert_id` so `byAlert` returns them. This is the one change that makes
   both B and D disappear.
2. Decide whether seeded MOCK alerts should be cleared when LIVE sync is active (a
   `DELETE FROM alerts WHERE data_source='MOCK'` on first live sync, or a reset step) so the
   Alerts page is not a mix of stale demo rows and real incidents.

---

## C. CONFIDENCE column renders `—`

### C.1 — Frontend render path

`packages/frontend/src/pages/Alerts.tsx` (~L83):

```tsx
<td><Confidence value={al.confidence} /></td>
```

`packages/frontend/src/components/ui.tsx` (`Confidence`, ~L254-259):

```tsx
export function Confidence({ value }: { value: number | null | undefined }) {
  if (value == null) return <>—</>;
  const pct = Math.round(value * 100);
  ...
  return <span style={{ color, fontWeight: 600 }}>{pct}%</span>;
}
```

So `—` renders **exactly when `al.confidence` is `null`/`undefined`**. The column and field
are wired correctly; the value is null.

### C.2 — Where the null comes from

- **LIVE alerts:** `HttpUrbaniAlertsAdapter.mapOne` sets `confidence: null`
  (`HttpUrbaniAlertsAdapter.ts` ~L200). The shared schema permits this:
  `confidence: z.number().min(0).max(1).nullable()`
  (`packages/shared/src/alerts.ts` ~L41, with a comment stating the QA API returns no score
  and null is modelled honestly, rendered `—`).
- **Persistence round-trip is faithful:** `alertRepository.insert` /
  `upsertLivePreservingStatus` write `confidence: alert.confidence` into the `REAL` column, and
  `rowToAlert` reads `confidence: row.confidence` back
  (`alertRepository.ts` ~L82, ~L158, ~L84). No field-name mismatch — the API payload includes
  `confidence`, it is simply `null` for every LIVE row.
- **Seeded MOCK alerts** *do* carry confidence (0.92/0.81/0.68), so if you reset to pure MOCK
  data the column would populate. The `—` the user sees is a direct consequence of running
  **live**.

### C.3 — Why every row shows `—` (conclusion)

The field is **present in the type, the API response, the DB column, and the frontend read**.
It renders `—` purely because the **LIVE QA alerts API does not return a confidence score**, so
the adapter stores `null` by design, and (if MOCK rows were cleared) no row has a value.

**Recommended fix (C):** choose a product stance:
- **Honest-null (current intent):** keep `null`, but render a clearer affordance than a bare
  em-dash in `Confidence` — e.g. a muted "n/a" with a tooltip "Live incidents from Bedrock do
  not include a confidence score." This removes the "data missing / broken" impression.
- **Derive a score:** if a confidence proxy is acceptable, compute one in
  `HttpUrbaniAlertsAdapter.mapOne` from severity + evidence count (as `MockAIProvider` does:
  `Math.min(0.6 + errorLogs.length * 0.05, 0.95)`), and label it clearly as derived.

---

## D. Alert detail — missing log evidence

### D.1 — What the detail view expects

`packages/frontend/src/pages/AlertDetail.tsx` reads:

- Confidence card (~L52): `<Confidence value={a.confidence} />` → `—` for LIVE (same as C).
- Evidence card (~L76-78): maps `a.evidence` → each cited log line. For LIVE alerts
  `a.evidence` is `[]`, so the card renders **empty** (no "none" placeholder).
- Related Logs card (~L82-100): `a.relatedLogs` → table; shows *"No related logs linked."*
  when empty. For LIVE **and** seeded alerts this is always empty (see B.3).
- Related Metrics card (~L101-106): shows `a.relatedMetricIds.length` snapshots — also always
  `0` because `metric_snapshots.alert_id` is never set.
- Recommended Actions (~L68-72): `a.recommendedActions` — LIVE alerts have 0 or 1 (the single
  `recommendation` string); seeded alerts have 2-3.

### D.2 — Backend `GET /alerts/:id`

`alertService.get` (`alertService.ts` ~L78-92) returns the persisted alert plus
`relatedLogs: logRepository.byAlert(alertId)`. Because no `log_references` row carries the
alert's id (B.3), `relatedLogs` is `[]`. `evidence`, `confidence`, `relatedLogIds`,
`relatedMetricIds` are all empty/null for LIVE alerts.

Note: `AlertDetail.tsx` PageHeader is hardcoded `source="MOCK"` (~L37) even for LIVE alerts —
a cosmetic provenance mislabel worth fixing alongside the above.

### D.3 — Which fields are missing/empty for LIVE seed/mock data

| Field | LIVE alert | Seeded MOCK alert |
|-------|-----------|-------------------|
| `confidence` | `null` → `—` | populated (0.68-0.92) |
| `evidence[]` | `[]` (empty card) | populated strings |
| `recommendedActions[]` | 0-1 item | 2-3 items |
| `relatedLogs` | `[]` ("No related logs linked.") | `[]` (alert_id never set) |
| `relatedMetricIds` | `0` | `0` |

**Recommended fix (D):**
1. Fixing B (populate `alert_evidence` and/or `log_references.alert_id` during live sync)
   fixes the empty Evidence and Related Logs cards.
2. Add an explicit empty-state to the Evidence card in `AlertDetail.tsx` (mirror the Related
   Logs "No related logs linked." pattern) so an empty `evidence[]` reads as intentional, not
   broken.
3. Fix the hardcoded `source="MOCK"` in `AlertDetail.tsx` to use the real `res.source`.

---

## Shared TypeScript contracts (for the implementer)

### `Alert` — `packages/shared/src/alerts.ts`

`urbaniIncidentAlertSchema` / `UrbaniIncidentAlert` (~L28-45):

```ts
alertId: string
timestamp: string (ISO datetime, offset)
service: string
environment: string
severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'   // SEVERITIES
anomalyType: string
summary: string
evidence: string[]
probableCause: string
recommendedActions: string[]
confidence: number (0..1) | null                   // nullable by design
modelId: string
```

`persistedAlertSchema` / `PersistedAlert` (~L52-62) extends the above with:

```ts
status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED'   // ALERT_STATUSES
acknowledgedBy?: string | null
acknowledgedAt?: string | null
relatedLogIds: string[]   // default []
relatedMetricIds: string[] // default []
```

`GET /alerts/:id` additionally returns `relatedLogs: LogEntry[]`
(not in the shared schema — assembled in `alertService.get`).

### `ChatAnswer` — NOT in shared; defined in `packages/backend/src/services/chatService.ts` (~L22-33)

```ts
interface ChatAnswer {
  answer: string
  citations: string[]        // always [] in live mode (QA returns counts, not lines)
  provider: string           // 'HttpUrbaniChatProvider' live / 'MockAIProvider' mock
  modelId: string
  service: string
  environment: string
  logsSource: string         // LIVE | MOCK | WAITING_FOR_INTEGRATION
  inputTokens: number
  outputTokens: number
}
```

The provider-boundary chat types live in
`packages/backend/src/integrations/ai/AIProvider.ts`: `AskLogsInput` (~L45-54),
`AskLogsResult` (~L61-70), `ChatTurn` (~L41-44). If a follow-up needs `ChatAnswer` shared with
the frontend, it should be lifted into `packages/shared/src` as a new contract.

---

## Conclusions

1. **A is by design, not corruption.** Chat (`POST /chat`) and Logs
   (`GET /logs/latest|history`) are different live endpoints with different grounding scopes;
   chat mixes **alerts** into its corpus, so it can describe a payments incident the per-service
   log window does not contain. The MockAIProvider "canned 403" hypothesis is false — the mock
   is not on the live chat path.
2. **B/D share one root cause:** LIVE alerts arrive with `evidence: []` and are never linked to
   `log_references` (the `alert_id` FK column exists in the schema but is never written for live
   data). Fix the linkage once and both the "no log evidence" and "empty alert detail" symptoms
   resolve.
3. **C is intentional honest-null:** `HttpUrbaniAlertsAdapter` sets `confidence: null` because
   QA returns no score; `Confidence` renders `—`. The pipeline is correct end-to-end — the
   choice is product (keep null with a clearer label, or derive a score).
4. **Secondary issues worth fixing in the same pass:** seeded MOCK alerts are never cleared when
   LIVE sync runs (mixed/stale Alerts list); `HttpUrbaniLogsAdapter.onFailure` silently returns
   `[]` so a 403 looks identical to "no logs"; `AlertDetail.tsx` hardcodes `source="MOCK"`; the
   Evidence card has no empty-state.

### Priority recommendation

Highest-leverage single fix: in the live path (`syncLiveAlerts` / `HttpUrbaniAlertsAdapter`),
**correlate each live alert to recent live log lines and populate `alert_evidence` +
`log_references.alert_id`**, and surface the QA grounding counts the chat already computes.
That reconciles alerts with logs (B/D), gives the chat answer verifiable backing (A), and
leaves only the product decision on confidence display (C).

---

*Investigation was read-only. File paths and line numbers are approximate (±a few lines) and
were read from the working tree at investigation time. No code, data, or running process was
modified.*
