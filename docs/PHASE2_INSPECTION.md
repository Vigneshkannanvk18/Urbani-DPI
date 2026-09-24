# Phase 2 — Inspection Report (Part 1)

Inspection of the Phase 1 codebase before production hardening. Goal: catalog
localhost/hardcoded assumptions, confirm config strategy, and confirm the
adapter architecture is intact so we harden rather than rebuild.

## Current structure (confirmed)

- **Monorepo:** npm workspaces — `packages/shared`, `packages/backend`, `packages/frontend`.
- **Backend:** Express + TS, layered (routes → services → repositories → integration adapters), better-sqlite3, JWT+bcrypt, Zod, Vitest. Config via zod-validated `config/index.ts`.
- **Frontend:** React 18 + Vite + React Router + Recharts. API client uses **relative `/api`** (browser-safe, already no hardcoded host). Dark theme in `styles.css`.
- **Adapters (must preserve):** `CloudWatchAdapter`, `BedrockAdapter`, `DynamoDBAdapter`, `UrbaniApplicationAdapter`, `AIProvider` + Mock implementations, selected by `INTEGRATION_MODE` in `integrations/index.ts`.

## localhost / hardcoded references — final state

All host literals were removed from application source and config. What remains
is only in three legitimate categories (comments, container self-probes, and an
overridable dev-tooling default) — never a hardcoded service host in code.

| Location | Original | Final state |
|---|---|---|
| `packages/backend/src/config/index.ts` `API_BASE_URL` | default `http://localhost:4000` | **optional, no default host** (null unless injected) |
| `packages/backend/src/config/index.ts` `FRONTEND_URL` | default `http://localhost:5173` | **optional, no default host** |
| `packages/backend/src/config/index.ts` `CORS_ORIGIN` | default `http://localhost:5173` | **default empty** (same-origin behind proxy) |
| `packages/frontend/vite.config.ts` | `?? 'http://localhost:4000'` | dev-only; env-driven (`VITE_DEV_API_HOST/PORT`), absent from prod bundle |
| Frontend API client | relative `/api` | unchanged — no host, browser-safe |
| `docker-compose.yml` / `frontend Dockerfile` healthchecks | `127.0.0.1:PORT` | container probing **itself** (loopback = same container); not a service host |
| `README.md` / docs | `http://localhost:8080` | human-facing example only ("open this on your machine") |

**Conclusion:** application source contains **zero** hardcoded hosts. The
production bundle contains no `localhost`. Remaining `localhost`/loopback strings
are comments, self-referential container healthchecks, an overridable dev default,
and documentation examples.

## Config strategy (current vs target)

- Current: single `.env.example` template + zod validation. No `.env.local/.production` split. **Already aligned** with the single-config requirement.
- Target additions: `DATABASE_URL`-style DB path, `FRONTEND_URL`, `AWS_ACCOUNT_ID`, comma-separated `CORS_ORIGIN`, and doc that values are injected at deploy time.

## Database

- SQLite via `better-sqlite3`, path from `DB_SQLITE_PATH` (env-configurable — good).
- Migration runner (`migrate.ts`) is forward-only and idempotent.
- Seed (`seed.ts`) is idempotent and **non-destructive** (uses `INSERT OR IGNORE`/existence checks; admin skipped if present). No auto-reset exists. Needs: explicit separate `reset` script (never auto-run) + Docker named volume for persistence.

## Security baseline

- CORS: single origin from env. JWT verify + bcrypt present. Error handler already sanitizes (no stack traces to client; 5xx returns opaque message).
- Missing: security headers (helmet), rate limiting on `/auth/login`. Will add.
- Logging already structured JSON with correlation IDs; no secret values logged (references by key name). Will re-verify redaction.

## Health checks

- Only `GET /api/health` (liveness). Need `GET /health` + `GET /ready` (DB check) for Docker healthchecks, without exposing secrets.

## API endpoints (to preserve unchanged)

auth login/logout/me · dashboard summary/health · alerts (+ /:id, /:id/acknowledge) ·
logs · metrics · services (+ /:id) · ai/analyses (+ /:id, POST /ai/analyze) ·
usage + /usage/cost · audit · settings GET/PUT.

## UI (to redesign — light theme)

- Single `styles.css` (dark). Components: `states.tsx`, `ui.tsx`, `Layout.tsx`. Pages under `pages/`.
- Redesign to light theme + `#D1990A` brand with centralized tokens and an expanded reusable component set. All data-fetching and API contracts stay identical.

## Plan summary

Harden config + CORS + health + security → Dockerize behind nginx reverse proxy
(browser only ever sees the proxy) → full light-theme UI redesign on a token
system → validate. No business logic or adapter changes.
