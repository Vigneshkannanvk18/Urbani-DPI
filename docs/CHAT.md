# Urbani Copilot chat: history, feedback and latency (DPI 2 items 8 and 9)

Status: built on branch `dpi2`, not integrated. Retention and PII policy are **client decisions pending**; the defaults below are placeholders.

## What it does

- Every chat exchange is stored per user (when `CHAT_HISTORY_ENABLED=true`, the default). `POST /api/chat` accepts an optional `sessionId`; without it a new session is created (title = first question, 60 chars; service and environment stored).
- Users can like/dislike each answer, resume or manage past conversations, and see how long each answer took end to end.
- A quality card on the AI Insights page (roles with `audit:view`) shows satisfaction, counts, latency and recent dislike comments.

## Data model

Reuses the item 1 repositories (SQLite default, DynamoDB driver):

| Entity | Fields |
|---|---|
| Session | id, userId, title, service, environment, messageCount, createdAt, updatedAt |
| Message | id (time-ordered), sessionId, role (`user`/`assistant`), content, citations, provider, modelId, source, `latencyMs` (= totalMs), tokens, createdAt, `meta` |
| `meta` (new, migration 005) | groundingNote, logsSource, providerMs, preparationMs, error (true for the marker of a failed provider call) |
| Feedback | messageId, sessionId, userId, rating (`LIKE`/`DISLIKE`, API: `UP`/`DOWN`), comment, createdAt, updatedAt. One per message |

New repository methods (both drivers + contract cases C-CH-11..14): `renameSession`, `deleteSession` (session + messages + feedback), `deleteFeedback`, `listFeedbackRecords`, `listLatencySamples`, `purgeOlderThan`. DynamoDB reads for the summary and the purge use a filtered **Scan** (there is no time-range index for chat items); fine for the expected volume, add a GSI if chat volume becomes large.

The public message id returned to clients is `<sessionId>~<messageId>` (DynamoDB needs the session to address a message).

A failed provider call stores the user message plus an assistant marker (`meta.error=true`, text "Urbani Copilot was unavailable for this question.") so the history stays coherent. The 503 response carries `error.details.sessionId` so the UI keeps following the same conversation. Error markers cannot be rated and are excluded from latency statistics.

## Endpoints

| Method and path | Permission | Notes |
|---|---|---|
| `POST /api/chat` | `chat:use` | Additive response fields: `sessionId`, `assistantMessageId`, `historyEnabled`, `latencyMs {totalMs, providerMs}`. Unknown or foreign `sessionId` = 404 before any provider call |
| `GET /api/chat/sessions?limit&cursor` | `chat:use` | Own sessions, newest first. `historyEnabled:false` and no items when disabled |
| `GET /api/chat/sessions/:id` | `chat:use` | Messages in order with feedback; 404 for someone else's session |
| `PATCH /api/chat/sessions/:id` `{title}` | `chat:use` | Rename |
| `DELETE /api/chat/sessions/:id` | `chat:use` | Hard delete; audited `chat.session_delete` (ids and counts only) |
| `PUT /api/chat/messages/:id/feedback` `{rating: UP, DOWN or null; comment?}` | `chat:use` | Idempotent upsert, `null` clears; comment max 500 chars, secrets masked; assistant messages in own sessions only. 409 `CHAT_HISTORY_DISABLED` when history is off |
| `GET /api/chat/feedback/summary?from&to` | `audit:view` | Default last 30 days. Counts, satisfaction %, per day, per service, latency p50/p95/max (nearest rank), last 10 dislike comments |

## Privacy

- **Owner-only.** Every read and write of conversation content is scoped to the signed-in user. Another user's session returns the same 404 as a missing one, for every role including Super Admin. No endpoint exposes another user's content.
- The summary never contains user identity or question text: recent comments show message id, service, comment and timestamp only. Comments are masked for secret-looking `key=value` pairs, bearer tokens and AWS key ids (best effort, not a guarantee), and the UI tells users not to enter secrets.
- Audit events never contain answers or full questions (`chat.query` keeps a short preview, as before).
- Questions and answers are stored in plain text in the application database. Whether that is acceptable, and for how long, is the client's PII/retention decision (see "Client input needed").

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CHAT_HISTORY_ENABLED` | `true` | `false`: nothing is persisted; the UI says so and disables feedback |
| `CHAT_RETENTION_DAYS` | `90` (placeholder) | Sessions idle longer than this are purged with their messages and feedback, daily, with **one** `chat.purge` summary audit event. `0` keeps forever. Runs under the same switch as the audit job (`AUDIT_RETENTION_JOB`) |

## Latency definition (item 9)

Measured in `chatService.ask` with a monotonic clock (`performance.now`), never wall-clock time:

- `totalMs`: request received (timestamp taken at the start of the route handler) until the response is ready. Includes validation, session handling, the log-window fetch, the **Urbani `/chat` round trip** and the user-message write. Excludes writing the assistant message and the audit event, which happen after the number is taken.
- `providerMs`: time inside `aiProvider.askLogs` (for the live provider this is the Urbani `/chat` call).
- `preparationMs`: `totalMs - providerMs` (before the provider call).

Stored on the assistant message (`latencyMs` = totalMs, `meta.providerMs`, `meta.preparationMs`), returned as `latencyMs`, written to a structured `chat.latency` log line, and added to the `chat.query` audit metadata as numbers only. Failed calls record latency too. Messages without latency (older data) show nothing in the UI, never a fake number.

UI: "Answered in 3.2 s" under each answer (tooltip: includes the Urbani /chat round trip, not just the model); answers over 10 s get a subtle slow style; while waiting, "Thinking... N s" with a hint after 15 s.

CloudWatch metric emission for these numbers is a possible follow-up (not built; no AWS calls). The summary endpoint computes percentiles from stored messages.

## Client input needed

1. Retention period for conversations (`CHAT_RETENTION_DAYS`, 90 is a placeholder).
2. PII/privacy policy for stored questions and answers (masking, consent text, encryption at rest requirements).
3. Whether auditors may ever read chat content (currently no; they see aggregates only).

## Not exercised

The real Urbani `/chat` latency (tested with a fake provider and a controlled delay) and the browser UI (type-checked and built, not clicked through).
