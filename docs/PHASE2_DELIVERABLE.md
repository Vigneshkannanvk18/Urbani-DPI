# Phase 2 — Deliverable Report

Production readiness + professional light-theme UI redesign. Phase 1 functionality,
API contracts, and the adapter architecture are fully preserved.

---

## 1. Production architecture

Layered architecture unchanged; only infrastructure/runtime configuration was hardened.

```
Browser
  → nginx (reverse proxy + SPA host)          ← the only browser-facing origin
       ├── /            → SPA static assets
       └── /api/*       → backend (Express)    ← internal Docker network only
                             → Service layer → Repository → Integration Adapters
                             → SQLite (Docker named volume)
```

Business logic is identical across local Docker, staging, and production — only injected
environment values differ (Part 5). There is no `if (production)` code fork.

## 2. Docker architecture

| Container | Base | Role | Exposed |
|---|---|---|---|
| `frontend` | nginx:1.27-alpine | Serves the SPA and reverse-proxies `/api` to the backend | `:8080` (only public port) |
| `backend` | node:20-bookworm-slim | Express API; runs idempotent migrations on start | internal only |
| volume `urbani_data` | — | Persists SQLite at `/data` across restarts/rebuilds | — |
| network `urbani_net` | bridge | Container-to-container (`backend:4000`) | — |

- Multi-stage builds; backend prunes dev deps; both run as non-root; healthchecks + `restart: unless-stopped`.
- One command: `docker compose up -d --build`.

## 3. Environment configuration strategy

- **Single** config model (`.env.example` template). No `.env.local/.development/.production` split.
- Zod-validated loader (`config/index.ts`), fails fast on invalid config.
- Values injected at deploy time (compose env, CI/CD secrets, task defs).
- Key vars: `NODE_ENV, PORT, DATABASE_URL, JWT_SECRET, API_BASE_URL, FRONTEND_URL, CORS_ORIGIN, INTEGRATION_MODE, AWS_REGION, AWS_ACCOUNT_ID, BEDROCK_*, CLOUDWATCH_*, DYNAMODB_*, COST_*, LOG_LEVEL`.

## 4. Localhost references removed / neutralized

| Location | Before | After |
|---|---|---|
| Frontend API client | already relative `/api` | unchanged (browser-safe) |
| Browser → backend | (implicit) | nginx reverse proxy; browser never sees backend host |
| `config` `API_BASE_URL` / `FRONTEND_URL` | `http://localhost:PORT` defaults | **optional, no default host** (null unless injected) |
| `config` CORS | localhost origin default | default empty = same-origin behind proxy |
| `config` DB path | `DB_SQLITE_PATH` | `DATABASE_URL` (volume path) with fallback |
| Server bind | default | `0.0.0.0` for container networking |
| Vite dev proxy | `localhost:4000` fallback | env-driven (`VITE_DEV_API_HOST/PORT`); dev-only, not in prod bundle |

**Verified:** application source has **zero** hardcoded hosts; the production JS
bundle contains no `localhost` and no secrets. The only remaining
`localhost`/loopback strings are (a) code comments, (b) container self-probe
healthchecks where loopback means the same container, and (c) documentation
examples a developer types on their own machine.

## 5. UI design system

Centralized tokens in `styles.css`; components in `components.css` + `components/ui.tsx`.
8px spacing scale, Inter typography hierarchy (page/section/card/body/caption/micro),
subtle shadows, consistent radius. No page redefines styles.

## 6. Color tokens (light theme, brand `#D1990A`)

`--color-primary #d1990a` (hover `#b8830a`, active `#9c6f08`, soft `#fbf3e0`),
`--color-background #f7f8fa`, `--color-surface #ffffff`, `--color-surface-2 #f3f4f6`,
`--color-border #e5e7eb`, text `#172033 / #667085 / #98a2b3`,
success `#12854e`, warning `#b8830a`, danger `#c0392b`, info `#1f6fb2` (+ soft variants),
severity LOW/MEDIUM/HIGH/CRITICAL families. Primary is used strategically (buttons, active nav,
key metrics, chart accent, focus), not as a global fill.

## 7. Components created

Button, Input, SearchInput, Select, Card, MetricCard, SeverityBadge, StatusBadge, SourceBadge,
PageHeader, FilterBar, Pagination, Loading/ErrorState/EmptyState/SkeletonTable, AsyncView,
Confidence, `fmtTime`, ChartCard (via `chart.tsx` theme), plus an inline icon set. Layout shell
(sidebar + topbar). No per-page style duplication.

## 8. Pages redesigned (all light theme, responsive, accessible)

`/login`, `/` (Dashboard: KPIs, System Health, observability chart, AI cost/budget, recent alerts + AI),
`/alerts` (filters/search/pagination), `/alerts/:id` (incident investigation view),
`/logs`, `/metrics` (KPI cards + charts), `/ai` (AI Insights), `/services`, `/usage`, `/audit`, `/settings`.
Every page carries a standardized `MOCK` provenance label and uses the same design system.

## 9. Security changes

- Security headers middleware (X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy, CSP, HSTS in prod; removes X-Powered-By).
- `trust proxy` enabled for correct client IPs behind nginx.
- Login rate limiting (per-IP fixed window).
- Env-driven CORS allow-list (same-origin by default behind the proxy).
- Sanitized error responses — no stack traces to clients (verified: 401 returns clean JSON).
- JWT + bcrypt retained; Zod input validation on all routes; parameterized SQLite queries (no injection); no secrets in logs/UI/bundle.
- Non-root containers, minimal images, no secrets in Dockerfiles.

## 10. Docker commands

```bash
# Build and start the full stack (single command)
docker compose up -d --build

# One-time / on-demand data setup (NOT run automatically)
docker compose exec backend node packages/backend/dist/db/migrate.js   # idempotent, safe
docker compose exec backend node packages/backend/dist/db/seed.js      # demo data (dev)
# reset is destructive and never automatic:
docker compose exec backend node packages/backend/dist/db/reset.js

# Health
curl http://localhost:8080/api/health     # liveness
curl http://localhost:8080/api/ready       # readiness (DB check)

# Stop (keeps the data volume)
docker compose down
```

## 11. Test results

- `npm test` → **16/16 passed** (auth, alert service incl. no-remediation, MockAIProvider grounding/determinism, adapter factory + guardrail).

## 12. Build result

- `npm run build` → shared → backend (tsc + copy-assets) → frontend (854 modules) — **clean**.
- `docker compose build` → both images built (backend ~353MB, frontend ~74MB).
- Runtime smoke test through the proxy: all 11 page APIs 200, SPA deep links 200, login OK, bundle free of localhost/secrets, light theme + `#D1990A` + Inter present in shipped CSS.

## 13. Remaining blockers

- None for Phase 2 scope. (Local `.env` carried `NODE_ENV=development` from Phase 1; production deployments set `NODE_ENV=production`, which enables HSTS and the seed/reset production guards.)
- Multi-instance rate limiting would need a shared store (Redis) — interface is ready; single-instance is fine for now.

## 14. Phase 3 integration readiness

- Adapter architecture intact: `CloudWatchAdapter`, `BedrockAdapter`, `DynamoDBAdapter`, `UrbaniApplicationAdapter`, `AIProvider` + Mock implementations, selected by `INTEGRATION_MODE`.
- Model IDs, guardrail ID, and inference params remain config-driven (never hardcoded in logic).
- Flip `INTEGRATION_MODE=aws` and implement the AWS adapters against the existing interfaces — no dashboard, API-contract, or business-logic changes required.
- `DATABASE_URL` + `DB_DRIVER` allow swapping SQLite for the real DynamoDB adapter without touching services.
