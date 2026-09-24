# Urbani — Proactive Observability & AI Troubleshooting Assistant

Production-quality **Phase 1 foundation** for an AI-assisted observability platform that will
eventually monitor Urbani's AWS applications, analyze CloudWatch logs/metrics with Amazon Bedrock,
detect anomalies, generate evidence-based troubleshooting recommendations, and surface them through
a centralized Admin Dashboard.

> **Phase 1 boundary.** This repo builds the complete application foundation and Admin Dashboard
> against **mock adapters**. It does **not** connect to the real Urbani application, AWS telemetry,
> CloudWatch, or Bedrock — those integrate in Phase 2/3 behind interfaces that already exist here.
> All demo values are clearly labelled **MOCK** and are never presented as real AWS data.

## Documented target flow

```
Urbani App (Elastic Beanstalk)
  → CloudWatch Logs & Metrics
  → EventBridge Scheduler (5 min)
  → Lambda Collector / Preprocessor
  → Amazon Bedrock + Guardrails
  → Lambda Alert Writer
  → DynamoDB (UrbaniAlerts)
  → Admin / Observability Dashboard
  → Urbani Engineering Team
```

Source of truth: `Urbani_AWS_Architecture_Proposal.docx` and `Urbani_DPI_Implementation_Plan.docx`.

## Architecture (layered, integration-ready)

```
Frontend (React)  →  API Layer (Express routes)  →  Service Layer  →  Repository / Data Layer
                                                          ↓
                                              Integration Adapters
                                    (CloudWatch · Bedrock · DynamoDB · UrbaniApp · AIProvider)
```

AWS, AI, and client-specific concerns are isolated behind adapter interfaces. The dashboard and
business logic have **no knowledge** of whether data comes from a mock or a real AWS integration.

### Monorepo layout (npm workspaces)

| Package | Purpose |
|---|---|
| `packages/shared` | Shared contracts: `UrbaniIncidentAlert`, domain types, `DataSource` (LIVE/MOCK/WAITING) |
| `packages/backend` | Express + TypeScript API, service layer, repositories, mock adapters, SQLite + migrations |
| `packages/frontend` | React + Vite Admin Dashboard |

## Tech stack

- **Backend:** Node.js, Express, TypeScript, better-sqlite3 (Phase 1 store), JWT + bcrypt, Zod, Vitest
- **Frontend:** React 18, Vite, React Router, Recharts
- **DB (Phase 1):** SQLite with versioned SQL migrations. The repository layer keeps this swappable
  for the real DynamoDB adapter in Phase 2.

## Getting started (Docker — recommended)

The whole stack runs behind a single nginx reverse proxy. The browser only ever
talks to that one origin; the backend is internal to the Docker network.

```bash
# 1. Configure env (never commit real secrets)
cp .env.example .env        # set a strong JWT_SECRET

# 2. Build and start everything with one command
docker compose up -d --build

# 3. One-time demo data (not run automatically)
docker compose exec backend node packages/backend/dist/db/seed.js
```

Then open the app in your browser at the published frontend port (default `8080`,
configurable via `FRONTEND_PORT`) on whatever host you deployed to — for a local
run that is `http://<your-host>:8080`. Sign in with the seeded admin
(`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, default `admin@urbani.local` / `ChangeMe123!`).

Health probes (relative to the app origin): `GET /api/health` (liveness),
`GET /api/ready` (readiness + DB check).
Stop with `docker compose down` (the data volume is preserved).

## Getting started (bare-metal dev)

```bash
npm install
cp .env.example .env
cp .env.example packages/backend/.env    # backend reads .env from its own cwd
npm run migrate && npm run seed
npm run dev:backend      # :4000
npm run dev:frontend     # :5173 (proxies /api to the backend)
```

## UI

Professional light theme with a centralized design-token system (brand `#D1990A`).
Tokens live in `packages/frontend/src/styles.css`; reusable components in
`components.css` + `components/ui.tsx`. See `docs/PHASE2_DELIVERABLE.md`.

### Useful scripts

| Script | Description |
|---|---|
| `npm run build` | Build shared → backend → frontend |
| `npm test` | Backend unit/service/adapter tests (Vitest) |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run seed` | Seed roles, admin user, and MOCK demo data |

## API contract

All admin routes require a bearer token. Response envelope for data endpoints is
`{ source, sourceNote, data }` where `source` is `LIVE` / `MOCK` / `WAITING_FOR_INTEGRATION`.

```
POST /api/auth/login          POST /api/auth/logout        GET  /api/auth/me
GET  /api/dashboard/summary   GET  /api/dashboard/health
GET  /api/alerts              GET  /api/alerts/:id         POST /api/alerts/:id/acknowledge
GET  /api/logs                GET  /api/metrics
GET  /api/services            GET  /api/services/:id
GET  /api/ai/analyses         GET  /api/ai/analyses/:id    POST /api/ai/analyze
GET  /api/usage               GET  /api/usage/cost
GET  /api/audit
GET  /api/settings            PUT  /api/settings           (read-only in Phase 1; audited)
```

## Integration boundary (how Phase 2/3 plug in)

Set `INTEGRATION_MODE=aws` and implement the AWS adapters against the existing interfaces:

| Interface (`packages/backend/src/integrations`) | Phase 1 | Phase 2/3 |
|---|---|---|
| `CloudWatchAdapter` | `MockCloudWatchAdapter` | `AWSCloudWatchAdapter` |
| `BedrockAdapter` | `MockBedrockAdapter` | `AWSBedrockAdapter` |
| `DynamoDBAdapter` | `MockDynamoDBAdapter` | `AWSDynamoDBAdapter` |
| `UrbaniApplicationAdapter` | `MockUrbaniApplicationAdapter` | real EB discovery |
| `AIProvider` | `MockAIProvider` | `BedrockAIProvider` |

The `analyzeTelemetry(input)` contract returns the documented `UrbaniIncidentAlert`. Model IDs,
guardrail ID, and inference params (temperature 0.0, max tokens 1024, top-p 1.0) are **config-driven**,
never hardcoded in business logic.

## Safety & principles (enforced in Phase 1)

- **Read-only / advisory / human-in-the-loop.** No automated remediation exists anywhere.
- **Evidence-based AI.** The mock provider only cites log lines present in its input, and returns
  no anomaly when there is no error evidence (grounding rule).
- **Cost control.** Budget thresholds are config-driven; usage is labelled MOCK. Historical AI
  spikes ($5–6k) motivate strict guardrails. No live billing is fabricated.
- **No secrets in source or UI.** Settings expose config placeholders only, never credentials.
- **Out of scope this phase:** Slack/Teams/email notifications, multi-tenant billing, VPC/IaC
  provisioning, and any production write access.

## Documentation

- `docs/PHASE1_DOD.md` — Phase 1 Definition of Done checklist and status.
