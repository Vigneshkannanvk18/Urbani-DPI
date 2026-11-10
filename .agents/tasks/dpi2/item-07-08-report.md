# DPI 2 items 7 and 8 (backlog B8 + B9): chat feedback, history, latency

Branch `dpi2`, worktree `c:\Antigravity\Urbani DPI\.worktrees\dpi2`. Commits: `0c51d29` (backend, shared, docs) and `f9db7c2` (frontend), on top of `906d3ca`. Not pushed. Built together, LEAN mode.

## Item 7: feedback + history (backlog B8)

- Every `POST /api/chat` exchange is stored per user. Optional `sessionId` resumes; otherwise a session is created (title = first question, 60 chars, plus service and environment). Assistant message stores answer, provider, model, logsSource, groundingNote, citations, tokens and latency. A failed provider call stores the user message plus an assistant error marker, and the 503 carries `error.details.sessionId` so the UI stays in the same conversation.
- Response additions (backward compatible): `sessionId`, `assistantMessageId` (opaque `<sessionId>~<messageId>`), `historyEnabled`, `latencyMs`.
- History API (`chat:use`, owner-only): list (newest first, cursor), get (messages + feedback), rename, hard delete (audited `chat.session_delete`, ids and counts only). Someone else's session, Super Admin included, is the same 404 as a missing one. No endpoint reads another user's content.
- Feedback API: `PUT /api/chat/messages/:id/feedback` (UP/DOWN/null, comment max 500, secrets masked with a new `redactText` helper next to the existing `redact`, idempotent, assistant messages in own sessions only, zod). `GET /api/chat/feedback/summary` reuses `audit:view` (Super Admin, Infra Admin, Reader/Auditor; no new permission): counts, satisfaction %, per-day, per-service, latency p50/p95/max, last 10 dislike comments as message id + service + comment + timestamp only.
- Config: `CHAT_HISTORY_ENABLED` (default true; false = nothing stored, UI says so, feedback returns 409 `CHAT_HISTORY_DISABLED`), `CHAT_RETENTION_DAYS` (default 90, PLACEHOLDER, 0 = forever). Daily purge job (`startChatRetentionJob`, same `AUDIT_RETENTION_JOB` switch) deletes idle sessions with messages and feedback and writes ONE `chat.purge` audit event.
- Repositories (both drivers + contract C-CH-11..14): `renameSession`, `deleteSession`, `deleteFeedback`, `listFeedbackRecords`, `listLatencySamples`, `purgeOlderThan`; `ChatMessage.meta` (SQLite migration 005 `meta_json`, DynamoDB attribute). DynamoDB summary and purge use a filtered Scan (no time-range index for chat); noted in docs/CHAT.md.
- UI: thumbs up/down on every stored assistant answer (toggle, optimistic with rollback, comment box after thumbs-down, disabled with tooltip when history is off or the answer was not stored); History control in the floating header and the /assistant page controls (open/resume restoring service and environment, rename, delete with confirm, new chat, load more); last session id kept in localStorage per user and resumed on reload (deleted session tolerated); "Copilot quality" card on AI Insights, visible only with `audit:view`. The `.assistant-panel-header` layout is unchanged (one extra 30 px icon button next to close).

## Item 8: latency (backlog B9)

- `chatService.ask` measures `totalMs` (from the start of the route handler, monotonic `performance.now`), `providerMs` (inside `aiProvider.askLogs`) and `preparationMs`. Stored on the assistant message, returned as `latencyMs {totalMs, providerMs}`, logged as `chat.latency`, and added to `chat.query` audit metadata as numbers (no answer text). Failures record latency too (also on the error marker and the FAILURE audit event).
- UI: "Answered in 3.2 s" with tooltip "Includes the Urbani /chat round trip, not just the model."; >10 s gets a subtle slow style; waiting shows "Thinking... N s" and, after 15 s, "This is taking longer than usual". Messages without latency show nothing. Quality card shows p50/p95/max.
- CloudWatch metric emission is documented as a possible follow-up; not built (no AWS calls).

## Files

Backend: `services/chatService.ts`, new `services/chatHistoryService.ts`, `routes/apiRoutes.ts`, `repositories/{types,validation}.ts`, `repositories/{sqlite,dynamodb}/chatRepository.ts`, `dynamodb/items.ts`, `db/migrations/005_dpi2_chat_meta.sql`, `db/migrateSqliteToDynamo.ts`, `config/index.ts`, `server.ts`, `lib/{errors,auditMetadata}.ts`. Shared: `domain.ts` (audit actions `chat.session_delete`, `chat.purge`). Frontend: `api/{client,endpoints}.ts`, `useAssistantChat.tsx`, `AssistantMessage.tsx`, `AssistantPanel.tsx`, new `AssistantHistory.tsx`, `icons.tsx`, `components.css`, `pages/AIInsights.tsx`. Docs: new `docs/CHAT.md`, `docs/RBAC.md`, `docs/AUDIT.md`, `.env.example`.

## Tests

- New `routes/chat.test.ts` (15 tests): persistence (new session, resume, failed call, history disabled), owner isolation (user B and Super Admin get 404 on get/rename/delete/feedback/resume), feedback (upsert, idempotent, clear, validation, redaction, assistant-only, ownership), delete cascade + audit, rename, retention purge + single summary event, summary math and privacy, RBAC (401, chat:use roles, summary roles), latency (fake provider with delay, monotonic clock spy, audit has numbers not answer text).
- Repository contract C-CH-11..14 (SQLite default; DynamoDB-gated). Updated only where required: `C-CH-02` (`meta: null`), `routes.baseline.json` (additive keys for steps 21 and 26), migrations list test.
- Default suite: **487 passed / 99 skipped** (was 468 / 95). DynamoDB Local (Docker, port 8001, container stopped afterwards): C-CH-01..14 28/28 (14 sqlite + 14 dynamodb).

## Verification

`npm run build` OK; `npm test` 487/99; `npx tsc -b --noEmit` in packages/frontend clean. Smoke on a worktree-local SQLite DB, `INTEGRATION_MODE=mock`, **port 4101** (4100 was held by a pre-existing node process, PID 27820 `dist/server.js`, started before this run; I did not touch it): two chats in one session, list and detail show 4 messages, feedback UP then DOWN with a comment (token masked), the same message flipped, summary counts and latency present, user B got 404 on get and delete and 403 on the summary, owner DELETE removed it (then 404). Server stopped, temp files removed.

## Not exercised (honest)

- Real Urbani `/chat` latency: only a fake provider with a controlled delay and the mock provider (about 4 ms). Real numbers will show once pointed at the QA API.
- Browser UI: typecheck and production build only. Not clicked through (history panel, feedback toggle, timer, quality card, localStorage resume).
- DynamoDB Scan-based summary/purge verified on DynamoDB Local only, not at volume or against AWS.
- No AWS calls of any kind.

## Client input needed

1. Chat retention period (`CHAT_RETENTION_DAYS`; 90 is a placeholder).
2. PII/privacy policy for stored questions and answers (plain text in the app database today; masking, consent text, encryption requirements).
3. Whether auditors may ever read chat content (currently no: owner-only, auditors see aggregates).
4. Confirm `audit:view` roles for the quality summary (or ask for a separate permission).
