# Urbani Observability — AWS Deployment Guide (for the AWS/Infra team)

This document specifies what the AWS team needs to **provision and deploy** the
Urbani Proactive Observability dashboard. The application is already
containerized; this guide covers the hosting runtime, sizing, networking,
secrets, and the deploy sequence.

> **Runtime decision:** the dashboard runs on **ECS Fargate** (serverless
> containers) — **not** Elastic Beanstalk and **not** ECS-on-EC2. There is **no
> EC2 instance type to choose**; capacity is Fargate **task size** (vCPU +
> memory). The AWS data pipeline (collector/writer) is serverless Lambda.
>
> Do **not** confuse this with `/aws/elasticbeanstalk/urbani-app` — that is the
> **customer's existing application** that Urbani *monitors* (the CloudWatch log
> source). It is read-only input, not something we deploy or change.

> **DPI 2 ("Radar UrbiNexus"):** proposed target additions are in §11 and in
> `docs/DPI2_PLAN_AND_GAP_ANALYSIS.md`; the DPI 2 architecture diagram is
> `OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.svg` (`.png`). Those services are
> a **proposed target**, not yet deployed — sections 1–10 below describe the
> **delivered DPI 1** runtime.

---

## 1. What gets deployed

Two container images, run as **one ECS Fargate task** (two containers sharing
the task network namespace), behind an Application Load Balancer:

| Container | Image | Port | Role |
|---|---|---|---|
| `frontend` | `urbani/frontend` (nginx + React SPA) | **8080** | Browser-facing. Serves the SPA at `/`, reverse-proxies `/api/*` to the backend. The **only** public entry point. |
| `backend` | `urbani/backend` (Node/Express) | **4000** | API. Not browser-facing; reached by the frontend over `127.0.0.1:4000` inside the task. |

Alongside, the CDK stack (`infra/`) provisions the AWS data pipeline:
EventBridge (5-min schedule) → Lambda Collector → Amazon Bedrock + Guardrails →
Lambda Alert Writer → DynamoDB (`UrbaniAlerts`), plus KMS, CloudTrail, and AWS
Budgets.

---

## 2. Compute sizing (Fargate task — no EC2 instance type)

Start small; this is a low-footprint dashboard.

| Setting | Recommended start | CDK context key | Notes |
|---|---|---|---|
| Task CPU | **512** (0.5 vCPU) | `dashboardCpu` | 256 / 512 / 1024 / 2048 / 4096 allowed |
| Task memory | **1024 MiB** (1 GB) | `dashboardMemoryMiB` | Must pair validly with CPU (512 CPU → 1–4 GB) |
| Desired tasks | **1** (use **2** for HA) | `dashboardDesiredCount` | 2+ spreads across AZs for availability |
| Capacity | **Fargate** (on-demand) | — | Add Fargate **Spot** later for cost savings on non-critical capacity |

**If you prefer ECS-on-EC2** instead of Fargate (only if you have a specific
reason — reserved-instance savings, etc.): smallest sensible instances are
**t3.small** (2 vCPU / 2 GB) or **t3.medium** (2 vCPU / 4 GB), burstable. This
adds host patching/capacity management that Fargate avoids. **Fargate is the
recommended default.**

---

## 3. Networking

- **VPC:** 2 AZs, public + private subnets (the CDK creates this; 1 NAT gateway
  to keep cost down — raise to 2 for full AZ redundancy).
- **ALB:** internet-facing, HTTP **:80** → target group → `frontend` container
  **:8080**. Health check path `/` (or `/healthz`), expect `200–399`.
- **Fargate service:** runs in **private** subnets; only the ALB is public.
- **TLS (production):** terminate HTTPS at the ALB — attach an **ACM
  certificate** and add a **:443** listener; redirect :80 → :443. (The skeleton
  ships HTTP :80; add 443 for any real environment.)
- **Security groups:** ALB SG allows 80/443 from the internet; task SG allows
  8080 only from the ALB SG.

### Required config change for ECS (important)
The local `nginx.conf` proxies `/api` to a Docker service name `backend`
(`upstream { server backend:4000; }`). On Fargate the two containers share one
network namespace, so this must resolve to **`127.0.0.1:4000`**. Either:
- update the `upstream` to `server 127.0.0.1:4000;` for the ECS image, **or**
- keep a container named `backend` and rely on ECS task DNS.

Confirm this before first deploy or `/api` calls will fail.

---

## 4. Container registry (ECR)

1. Create two ECR repositories: `urbani/frontend`, `urbani/backend`.
2. Build and push both images (CI or local):
   ```bash
   # from repo root
   docker build -f packages/backend/Dockerfile  -t <acct>.dkr.ecr.<region>.amazonaws.com/urbani/backend:<tag>  .
   docker build -f packages/frontend/Dockerfile -t <acct>.dkr.ecr.<region>.amazonaws.com/urbani/frontend:<tag> .
   docker push <acct>.dkr.ecr.<region>.amazonaws.com/urbani/backend:<tag>
   docker push <acct>.dkr.ecr.<region>.amazonaws.com/urbani/frontend:<tag>
   ```
3. Pass the image URIs to the CDK via context: `frontendImage`, `backendImage`.

---

## 5. Persistence (decision required)

The backend uses **SQLite at `/data/urbani.sqlite`**. Fargate task storage is
**ephemeral** — it is lost when a task is replaced. Choose one:

- **A — EFS (keep SQLite):** create an EFS file system, mount it to the task at
  `/data`. Data survives deploys. Simplest path to parity with local.
- **B — DynamoDB (recommended long-term):** the stack already provisions the
  `UrbaniAlerts` table; migrate persisted data there and drop the volume. Best
  for horizontal scaling (desiredCount ≥ 2).

Until one is chosen, running >1 task with SQLite will give each task its own
copy. Pick **A** for a quick lift-and-shift, **B** for scale.

---

## 6. Secrets & configuration (never bake into images)

Inject at deploy time via **ECS Secrets** from **AWS Secrets Manager / SSM
Parameter Store**. Do **not** put these in the image, task definition plaintext,
or source.

| Variable | Purpose | Source |
|---|---|---|
| `JWT_SECRET` | Signs auth tokens | Secrets Manager (strong, rotated) |
| `URBANI_API_BASE_URL` | Live Urbani logs/chat API Gateway base | SSM / config |
| `URBANI_API_KEY` | API key for the Urbani API (`x-api-key`) | **Secrets Manager — rotate the shared key** |
| `INTEGRATION_MODE` | `mock` / `live` / `aws` | config (`live` for real data) |
| `URBANI_SERVICE` | `urbani-app` | config |
| `URBANI_REFRESH_MINUTES` | Poll cadence (default 5) | config |
| `URBANI_LOGS_WINDOW_MINUTES` | `0` = live window only (recommended) | config |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Bootstrap admin — rotate/remove after first login | Secrets Manager |
| `AWS_REGION`, `AWS_ACCOUNT_ID` | Target account/region | deploy env |
| `BEDROCK_PRIMARY_MODEL_ID`, `BEDROCK_GUARDRAIL_ID` | AI model + guardrail | config |

**Security notes:**
- The `URBANI_API_KEY` was shared in plaintext during setup — **rotate it** and
  store the new value in Secrets Manager.
- The backend calls the Urbani API **server-side only**; the key is never sent
  to the browser.

---

## 7. IAM (least privilege)

- **Task execution role:** pull from ECR, write logs to CloudWatch, read the
  injected Secrets Manager/SSM values.
- **Task role (backend):** only what the app needs at runtime (e.g. read the
  `URBANI_API_KEY` secret; DynamoDB access **only** if persistence option B is
  chosen).
- **Pipeline roles (already in CDK):** the collector role is **read-only**
  CloudWatch + `bedrock:InvokeModel` scoped to `/aws/elasticbeanstalk/urbani-*`
  and the configured model(s); the writer role writes **only** to `UrbaniAlerts`.
  The MVP has **no write access to the customer's production app**.

---

## 8. Deploy sequence

```bash
# 1. Build + push images to ECR (section 4).

# 2. Provision the stack (from infra/).
cd infra
npm install
npm run build

# 3. Synthesize (no deploy) to review the CloudFormation.
npx cdk synth \
  -c account=<ACCOUNT_ID> -c region=<REGION> \
  -c bedrockModelId=<model-id> \
  -c frontendImage=<ecr-uri>:<tag> \
  -c backendImage=<ecr-uri>:<tag> \
  -c dashboardCpu=512 -c dashboardMemoryMiB=1024 -c dashboardDesiredCount=1

# 4. Bootstrap once per account/region, then deploy (when authorized).
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
npx cdk deploy
```

CDK outputs include **`DashboardUrl`** (the ALB URL) and **`DashboardRuntime`**
(the Fargate sizing in effect).

---

## 9. Observability & operations

- **Container logs:** CloudWatch Logs group `/urbani/dashboard` (streams
  `frontend` / `backend`). ECS **Container Insights** is enabled.
- **Health:** ALB target health on `/`; the backend also exposes `/health`.
- **Deploy safety:** the service uses a **deployment circuit breaker with
  rollback** and `minHealthyPercent: 100`, so a bad image rolls back and the
  running count never drops during deploys.
- **Cost guardrails:** AWS Budgets with soft ($50) / hard ($100) monthly alerts
  (configurable via `budgetSoftUsd` / `budgetHardUsd`).

---

## 10. Pre-deploy checklist

- [ ] ECR repos created; both images built and pushed with a versioned tag
- [ ] `nginx.conf` upstream points at `127.0.0.1:4000` for the ECS image (§3)
- [ ] Persistence option chosen: **EFS** (A) or **DynamoDB** (B) (§5)
- [ ] All secrets in Secrets Manager/SSM; **`URBANI_API_KEY` rotated** (§6)
- [ ] ACM certificate + :443 listener for production TLS (§3)
- [ ] `INTEGRATION_MODE=live` set (so logs/Copilot use real data)
- [ ] IAM task/execution roles reviewed for least privilege (§7)
- [ ] `cdk synth` reviewed and approved before `cdk deploy`

---

## 11. DPI 2 additions (PROPOSED — "Radar UrbiNexus")

> **Honesty banner — read first.** Everything in this section is a **PROPOSED
> target** for DPI 2, validated with the client at kickoff. It is **not yet
> built or deployed**. The delivered **DPI 1** runtime (sections 1–10 above) is
> still **SQLite** persistence plus **un-deployed CDK scaffolding** for the
> incident/alert pipeline; the running app does not use it. Monitoring today
> covers **QA only** — expanding to **Main** and **Payment** is **subject to
> client access**, so those surfaces stay **MOCK / WAITING_FOR_INTEGRATION**
> until access is granted, never LIVE. Nothing below implies Cognito, DynamoDB
> persistence, the notifier pipeline, or Synthetics are already running.
>
> Full scope, gap analysis, per-item blockers, and the exact client inputs
> required are in **`docs/DPI2_PLAN_AND_GAP_ANALYSIS.md`**. The DPI 2
> architecture diagram is **`OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.svg`**
> (and `.png`), where orange marks the proposed additions.

These additions layer on top of the DPI 1 runtime; the sections they relate to
are cross-referenced so sizing, networking, secrets, and IAM stay coherent.

### 11.1 Identity — Amazon Cognito (+ Google Workspace SSO/MFA) — PROPOSED

- Stand up **Amazon Cognito** federated with **Google Workspace** via
  **SAML/OIDC** for **SSO + MFA**. The backend validates the Cognito token and
  enforces permissions server-side.
- **4 RBAC roles** replace today's single access level, mapped from IdP groups:
  **Super Admin**, **Infrastructure Administrator**, **QA Operator**, and
  **Reader / Auditor** (the Reader/Auditor must not be able to mutate
  configuration). Authorization is enforced in the API, not just hidden in the
  UI.
- **Documented fallback:** if IdP admin access is not available in time, keep
  the existing **JWT** login and add **TOTP MFA** — lighter, no IdP dependency —
  to still meet the MFA success criterion.
- Status: PROPOSED. DPI 1 ships single-level JWT auth with one bootstrap admin.

### 11.2 Persistence — DynamoDB as the LIVE primary store (replaces SQLite) — PROPOSED

- DPI 2 **commits to persistence option B (DynamoDB)** from **§5 "Persistence
  (decision required)"**. DynamoDB becomes the **live primary store**,
  replacing the SQLite volume.
- It holds **users & preferences, audit events, chat history + feedback, and
  alerts**.
- Moving off SQLite **removes the single-writer limit**, which is what forces
  DPI 1 to run exactly one task. With DynamoDB the service can run **≥ 2 ECS
  tasks across 2 AZs** (see §11.8).
- Status: PROPOSED. DPI 1 persists to SQLite at `/data/urbani.sqlite`; the
  `UrbaniAlerts` table exists only as un-deployed CDK scaffolding.

### 11.3 Alerts & notifications pipeline — PROPOSED

- **DynamoDB Streams → Lambda Notifier → Amazon SNS (email)** plus **Slack
  and/or Microsoft Teams webhooks**. Webhook URLs live in Secrets Manager (see
  §11.6).
- Notification **rules by severity and service**, with **deduplication** so a
  single incident does not spam channels.
- A critical failure (real or simulated) must generate an alert by **email and
  at least one of Slack/Teams** (a DPI 2 success criterion).
- Status: PROPOSED. DPI 1 shows alerts in-app only; no outbound notifications.

### 11.4 Health & KPIs — PROPOSED

- **CloudWatch Synthetics** canaries + **Route 53 health checks** for **QA,
  Main, and Payment**, feeding a health/uptime panel. **Main and Payment are
  subject to client access** — until granted they stay
  **MOCK / WAITING_FOR_INTEGRATION**, never LIVE.
- **Container Insights** for the dashboard service itself.
- Status: PROPOSED. DPI 1 has no health panel; Metrics/Services are MOCK.

### 11.5 Log management — PROPOSED

- **CloudWatch Logs Insights** for **full-stream search** across
  **severity / server / date range / text / regex**, going beyond the "relevant"
  (flagged) lines DPI 1 can currently surface.
- **Log/report export** in **CSV, JSON, and PDF**, staging large exports in
  **S3** with signed URLs.
- Status: PROPOSED. DPI 1 filters only the current window and has no export.

### 11.6 Monitoring scope — PROPOSED

- Monitoring **expands from QA to Main + Payment**, **subject to client access**
  (CloudWatch log-group access/ARNs, or an agreed extension of the Urbani
  `/logs` API). Where access is not granted, those services remain
  **MOCK / WAITING_FOR_INTEGRATION**.
- Status: PROPOSED. DPI 1 monitors QA only.

### 11.7 DPI 2 secrets note (extends §6 — do not edit the §6 table)

The following **new** secrets are injected from **AWS Secrets Manager** at
deploy time, exactly as in §6 (never baked into images, never sent to the
browser). This note **adds to** the §6 intent; it does not change any existing
DPI 1 secret.

| Variable | Purpose |
|---|---|
| `SLACK_WEBHOOK_URL` | Slack notification webhook for the alerts pipeline (§11.3) — server-side only |
| `TEAMS_WEBHOOK_URL` | Microsoft Teams notification webhook for the alerts pipeline (§11.3) — server-side only |
| `COGNITO_USER_POOL_ID` | Cognito user pool for SSO/MFA (§11.1) |
| `COGNITO_CLIENT_ID` | Cognito app client ID (§11.1) |
| `COGNITO_DOMAIN` | Cognito hosted-UI domain / OIDC issuer (§11.1) |

The Slack/Teams webhook URLs are used by the Lambda Notifier **server-side
only** and are never exposed to the browser.

### 11.8 DPI 2 IAM note (extends §7 — least privilege)

Least-privilege **task-role** additions on top of §7, scoped to what the DPI 2
features need at runtime:

- **DynamoDB** — read/write **only** the DPI 2 tables (users/preferences,
  audit, chat history + feedback, alerts).
- **SNS** — `Publish` **only** to the alerts topic.
- **CloudWatch Synthetics + Logs Insights** — **read** (query canaries and run
  Logs Insights queries).
- **S3** — `PutObject` / `GetObject` **only** on the export bucket/prefix.

The pipeline roles keep the DPI 1 posture: **no write access to the customer's
production app**.

### 11.9 ECS operations — PROPOSED

- **Service Auto Scaling** to **≥ 2 tasks across 2 AZs**, unblocked once DynamoDB
  (§11.2) removes the single-writer constraint (updates the DPI 1 default of a
  single task in §2).
- The DPI 2 least-privilege **Task Role** (§11.8) covers DynamoDB / SNS /
  CloudWatch Synthetics + Logs Insights / S3.
- Status: PROPOSED.

### 11.10 Deployment runbook, go-live matrix and integration plan (item 14)

The step-by-step parallel deployment of DPI 2 (scripts `deploy-ecs-dpi2.sh` and `redeploy-dpi2.sh`, configuration in `deploy/dpi2.env.example`), the verification checklist, rollback, cutover to `dpi.urbani.io` and data migration choices are in [DPI2_DEPLOYMENT_RUNBOOK.md](DPI2_DEPLOYMENT_RUNBOOK.md). Everything the client must provide, per item, is in [DPI2_GO_LIVE_MATRIX.md](DPI2_GO_LIVE_MATRIX.md); merging the `dpi2` branch into `main` is in [DPI2_INTEGRATION_PLAN.md](DPI2_INTEGRATION_PLAN.md). The DPI 2 scripts are authored and validated locally only; they have not been run against AWS.
