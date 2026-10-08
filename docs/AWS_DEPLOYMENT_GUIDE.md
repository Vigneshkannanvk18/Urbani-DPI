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
