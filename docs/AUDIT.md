# Audit log (DPI 2 item 3)

The audit log is an append-only record of configuration changes and sensitive queries. It works on both persistence drivers (SQLite and DynamoDB). Which actions count as sensitive is a DRAFT pending client input.

## Audited actions

The single source of truth is `AUDIT_ACTION_CATALOG` in `packages/shared/src/domain.ts`. Auth and access events are grouped under SENSITIVE_QUERY.

| Action | Category | Written by |
|---|---|---|
| `LOGIN` | SENSITIVE_QUERY | `POST /api/auth/login` (success) |
| `auth.login_failed` | SENSITIVE_QUERY | `POST /api/auth/login` (FAILURE) |
| `LOGOUT` | SENSITIVE_QUERY | `POST /api/auth/logout` |
| `access.denied` | SENSITIVE_QUERY | permission guard (DENIED) |
| `ALERT_VIEWED` | SENSITIVE_QUERY | `GET /api/alerts/:id` |
| `chat.query` | SENSITIVE_QUERY | `POST /api/chat` (service + question preview, never the answer; end-to-end `latency` numbers and `sessionId`; FAILURE if the assistant is unavailable) |
| `chat.session_delete` | CONFIG | `DELETE /api/chat/sessions/:id` (session id and message count only) |
| `chat.purge` | CONFIG | Chat retention job (counts of purged sessions/messages/feedback only) |
| `logs.search` | SENSITIVE_QUERY | `GET /api/logs` (filter parameters only, never log content) |
| `audit.view` | SENSITIVE_QUERY | `GET /api/audit` (filter parameters) |
| `ALERT_ACKNOWLEDGED` | CONFIG | `POST /api/alerts/:id/acknowledge` |
| `CONFIG_CHANGED` | CONFIG | `PUT /api/settings` (requested key names only) |
| `ai.analyze` | CONFIG | `POST /api/ai/analyze` |
| `user.create`, `user.role_change`, `user.activate`, `user.deactivate`, `user.password_reset` | CONFIG | `/api/users` |
| `audit.purge` | CONFIG | retention job (one summary event) |
| `INTEGRATION_UPDATED` | CONFIG | reserved |

Each request produces exactly one event per audited action.

## Fields

`id`, `timestamp` (ISO UTC), `actor` (user email), `action`, `target`, `result` (`SUCCESS` / `FAILURE` / `DENIED`), `metadata`. The request context is stored in `metadata.ctx`: `userId`, `email`, `role`, `ip` and `requestId` (the correlation id, also returned in the `x-correlation-id` header). Events written outside a request (the retention job) have no `ctx` and use actor `system`.

## Redaction

`packages/backend/src/lib/auditMetadata.ts` redacts every metadata value whose key matches password, passwd, token, authorization, api key, secret or cookie (case-insensitive, any depth), inside both repository drivers' `record`. Passwords, tokens, API keys and full chat answers are never stored. Chat questions are stored as an 80 character preview.

## API (permission `audit:view`: Super Admin, Infra Admin, Reader / Auditor in the draft matrix)

- `GET /api/audit`: newest first. Filters: `from`, `to` (ISO date-time), `actor` (email), `userId`, `action`, `result`, `category` (`CONFIG` / `SENSITIVE_QUERY`), `text` (target and metadata, case-insensitive), `limit` (1..200, default 50), `cursor`. Response: `data: { items, nextCursor, limit }`. Without any of the new parameters the DPI 1 response (`page`, `pageSize`, `total`) is returned.
- `GET /api/audit/actions`: known actions with category and description, plus categories and results, for the filter dropdown.
- There is no update or delete endpoint. The only delete in the code base is the retention purge.

DynamoDB access patterns follow ADR 0001: time range and newest-first on the `AUDIT` partition (SK `<timestamp>#<id>`), by actor on GSI1. Filters on action, result, text and metadata are applied while paging the same key range, so cursors keep working. The purge queries the `AUDIT` partition below the cutoff and batch-deletes; no schema change.

## Retention

- `AUDIT_RETENTION_DAYS` (default 365, `0` keeps everything).
- `AUDIT_RETENTION_JOB` (default `true`; `false` disables the job).
- The job runs once at startup and then every 24 hours, deletes events older than the window and records ONE `audit.purge` event with `purged`, `cutoff` and `retentionDays`.
- The retention period is a client decision; 365 days is a placeholder.

## UI

`Audit log` page (route `/audit`, visible with `audit:view`): date range, user, action, result and category filters, free-text search, table with expandable (redacted) metadata, cursor pagination (Previous / Next), empty and error states.
