# DPI 2 ("Radar UrbiNexus") — Development Backlog & Progress Tracker

Single source of truth for building DPI 2 one item at a time. Every item run MUST read this file first and update its row + the Progress log when done.

- Plan / gap analysis: `c:\Antigravity\Urbani DPI\docs\DPI2_PLAN_AND_GAP_ANALYSIS.md`
- Client scope docs: `c:\Antigravity\Urbani DPI\DPI2_Urbani_UrbiNexus_EN.docx`, `c:\Antigravity\Urbani DPI\Upgrades_UrbiNexus_DPI_EN.pdf`
- DPI 2 target diagram: `c:\Antigravity\Urbani DPI\OUTPUT\Urbani_AWS_Architecture_Diagram_DPI2.png`
- Per-item reports: `c:\Antigravity\Urbani DPI\.agents\tasks\dpi2\item-NN-report.md`

## Ground rules (apply to every item)

1. **Branch / worktree.** All DPI 2 code lives on branch `dpi2` in the worktree `c:\Antigravity\Urbani DPI\.worktrees\dpi2` (created from `main` by item 1). Commit on `dpi2` after each item. **Never merge, rebase onto, or fast-forward `main`. Never push.** `main` stays the deployable DPI 1 build; it is integrated only after client approval. Keep the worktree between items.
2. **No AWS changes.** Never run `deploy-ecs.sh` / `redeploy.sh`, `cdk deploy`, or any AWS CLI/SDK call that creates, changes or deletes resources. IaC and deploy-script changes are *authored and reviewed*, not executed.
3. **Build now, integrate later.** Anything blocked on a client input is built behind config/adapters with a local stand-in (mock, DynamoDB Local, dry-run sink, placeholder asset) and an honest "not configured" / `WAITING_FOR_INTEGRATION` state. The item report must say exactly what to set to switch it to LIVE.
4. **Honesty / provenance.** Keep the DPI 1 LIVE / MOCK / WAITING_FOR_INTEGRATION model. Never fabricate data, log lines, scores or AI answers. Proposed or default decisions (e.g. a draft permission matrix) are labelled as drafts pending client sign-off.
5. **Read-only assistant.** The product never executes remediation. Human in the loop.
6. **Don't disturb DPI 1.** The main workspace runs DPI 1 dev servers on :4000 / :5173 with its own SQLite file. For runtime checks in the worktree use other ports (e.g. backend 4100, frontend 5273) and a worktree-local database file, and stop any servers you start. Never touch `c:\Antigravity\Urbani DPI\packages\backend\data\*`. Never commit `.env` files or secrets.
7. **Quality gate per item.** `npm run build` (root) passes; `npm test` passes (default suite needs no Docker/AWS/network); `npx tsc -b --noEmit` in `packages/frontend` is clean; plus the item's behavioral verification. The HTTP API contract stays backward compatible unless the item requires a change.

## Items (in build order — matches the roadmap in the DPI 2 plan, §5)

| # | Backlog | Item | Pri | Status | Build now | Integrate when Urbani provides |
|---|---|---|---|---|---|---|
| 1 | B1 | Persistence: async repository layer + DynamoDB driver (SQLite stays default) | P0 | DONE (integration pending) | Async driver-agnostic repositories; DynamoDB driver (users with role + preferences, audit, alerts + evidence/links, chat sessions/messages/feedback, usage, AI analyses, integration status); contract tests run on both drivers; DynamoDB Local for dev; IaC table definitions; SQLite→DynamoDB copy script | AWS account/region → create tables + task-role permissions, set `DB_DRIVER=dynamodb` |
| 2 | B2 | RBAC: Super Admin, Infra Admin, QA Operator, Reader/Auditor (API + UI) + user management | P0 | DONE (integration pending) | Role model, draft permission matrix, server-side enforcement, UI gating, per-role test cases | Sign-off of the permission matrix |
| 3 | B4 | Audit log: config changes + sensitive queries | P0 | DONE (integration pending) | User / action / target / timestamp / result events; Audit view with filters; retention setting | List of "sensitive" actions + retention period |
| 4 | B5 | Advanced log filters + search (severity, server, date range, text, regex, pagination) | P0 | DONE (integration pending) | API + UI filters over current sources; CloudWatch Logs Insights adapter behind config | Log-group ARNs + read access (QA/Main/Payment), or Urbani `/logs` extension |
| 5 | B3 | MFA + SSO | P1 | DONE (integration pending) | TOTP MFA on the existing JWT login (enrol, verify, recovery); pluggable auth provider with a Cognito/OIDC adapter behind config | Google Workspace / IdP admin access + group→role map |
| 6 | B7 | Automatic alerts: email + Slack + Teams | P1 | DONE (integration pending) | Rules by severity/service, dedup window, channel adapters (SNS email, Slack, Teams), test-send, dry-run sink, notifier IaC | Alert e-mails + Slack/Teams webhook URLs + rules |
| 7 | B8 | Chat feedback (like/dislike) + conversation history | P1 | DONE (integration pending) | Feedback per answer, session list/resume, stored per user | Retention + PII policy |
| 8 | B9 | AI latency metric in chat | P1 | DONE (integration pending) | End-to-end latency per answer (incl. Urbani `/chat`), shown + stored | — |
| 9 | B10 | Health / uptime panel (QA, Main, Payment) | P1 | DONE (integration pending) | Status panel; QA from reachable probes; Main/Payment `WAITING_FOR_INTEGRATION`; Synthetics + Route 53 IaC | Main/Payment endpoints + access |
| 10 | B11 | Corporate branding + dark mode | P1 | DONE (integration pending) | Theme tokens, dark-mode toggle persisted per user, logo slot, placeholder palette | Official logo (SVG/PNG) + palette hex |
| 11 | B6 | Export logs/reports: CSV, JSON, PDF | P1 | DONE (integration pending) | Streamed export endpoints, PDF report, audited | S3 bucket (optional, large exports) |
| 12 | B12 | Dashboard personalization (rearrangeable widgets) | P2 | DONE (integration pending) | Drag/reorder widgets, per-user layout, reset to default | Which widgets are in scope |
| 13 | B13 | Load tests + extended automated suite | P2 | DONE (integration pending) | k6 scripts (API + log-heavy scenario), thresholds as config | SLO thresholds |
| 14 | — | Deployment readiness (authored, not executed) | — | DONE (integration pending) | `deploy-ecs.sh` / `redeploy.sh` / CDK: DynamoDB tables, task role, Cognito, SNS, Synthetics, webhook secrets, ECS autoscaling ≥2 tasks across 2 AZs | Approval to deploy |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `DONE (integration pending)`, `BLOCKED`.

## Execution mode (set by user — go fast, control cost)

**LEAN (Option A).** For items 2–14: ONE coder per item, no design phase, no design-review loop, no multi-round fix/review. Build + run `npm test` once + frontend typecheck, orchestrator spot-checks, move on. Minor/cosmetic issues are acceptable and get caught when the running app is tested — do NOT spend iterations polishing NITs. Use normal effort, not "max". Still keep the quality gate (build+test+typecheck pass) and the ground rules (dpi2 worktree, no AWS, honesty/provenance). Item 1 (persistence foundation) was the one exception that justified the heavier design loop; everything after is lean.

## Client inputs pending

See §6 of the DPI 2 plan. Nothing received yet.

## Progress log

_(Each item appends: date, item #, commit hash on `dpi2`, one-paragraph summary, what is pending client input, link to its report.)_

### 2026-11-06: item #1 (persistence foundation): DONE (integration pending)

- **Commit on `dpi2`:** `4cb8eff86590950e26800e86aa7946a3a26f4fac` (7 commits `eb6d0f2`..`4cb8eff` on top of `5c81908`; not pushed; `main` unchanged at `5cc5ffa`).
- **Summary:** The backend now reaches storage only through async, driver-agnostic repositories from `getRepositories()`. `DB_DRIVER=sqlite` stays the default with DPI 1 behaviour unchanged (27 route steps match the pre-change baseline). A new `DB_DRIVER=dynamodb` driver stores every entity in one table `UrbaniApp` (PK/SK + one overloaded GSI1, on-demand, CMK, PITR, RETAIN) and covers users with role, preferences, audit, alerts with evidence/links, telemetry, usage, AI analyses, integrations and chat sessions/messages/feedback. Added DynamoDB Local tooling (`dynamo:tables`), a SQLite→DynamoDB migration (`dynamo:migrate`, dry-run, idempotent), AWS guards, the CDK table + least-privilege task role (authored, not deployed) and ADR 0001. Tests: 340 total (73 pre-existing unchanged + 267 new); default suite 260 passed / 80 DynamoDB opt-in skipped; with DynamoDB Local (actually exercised) 340/340. Build, frontend typecheck and infra offline check pass. Code review: APPROVED. Follow-ups: item 2 must require an explicit role on create-user; tracked stale `packages/backend/data/*-wal/*-shm` files need a separate cleanup.
- **Pending client input:** AWS account id and region (must match the ECS region, `us-east-1` today); permission to create the `UrbaniApp` table and the task-role policy; operator credentials and ECS Exec access to copy the DPI 1 SQLite file and run `dynamo:migrate`; deploy approval (item 14) to set `DB_DRIVER=dynamodb`.
- **Report:** [item-01-report.md](item-01-report.md)

### 2026-11-06: item #2 (RBAC + user management): DONE (integration pending)

- **Commit on `dpi2`:** `1b3b3d361386520021e6a4c2166f96eacaa1aac8` (on top of `4cb8eff`; not pushed).
- **Summary:** Four roles and a DRAFT permission matrix live in `packages/shared/src/rbac.ts`. Every authenticated API route is guarded by `requirePermission` with a per-request user lookup (role changes and deactivation apply immediately). Added the Super-Admin-only user management API with guard rails and audit events, and the UI gating, role badge, forbidden screen and Users page. Tests: 280 passed / 81 skipped (+20 default); build, frontend typecheck and a port-4100 smoke pass.
- **Pending client input:** sign-off of the permission matrix (#11); Google group to role mapping for item 5.
- **Report:** [item-02-report.md](item-02-report.md)

### 2026-11-06: item #3 (audit log): DONE (integration pending)

- **Commit on `dpi2`:** `1c1e529` (on top of `1b3b3d3`; not pushed).
- **Summary:** One shared catalog classifies audited actions (CONFIG / SENSITIVE_QUERY); gaps filled (AI analyze, log search, audit view, chat.query); central redaction; request context (user id, role, IP, request id) in metadata; `GET /api/audit` filters + cursor and `/api/audit/actions`; `purgeOlderThan` on both drivers and a daily retention job (`AUDIT_RETENTION_DAYS`, `AUDIT_RETENTION_JOB`); new Audit page; `docs/AUDIT.md`. Tests: 308 passed / 83 skipped; DynamoDB Local audit contract cases 18/18.
- **Pending client input:** list of actions considered sensitive; retention period (365 is a placeholder).
- **Report:** [item-03-report.md](item-03-report.md)

### 2026-11-06: item #4 (advanced log filters and search): DONE (integration pending)

- **Commit on `dpi2`:** `21bb34e` (on top of `1c1e529`; not pushed).
- **Summary:** `GET /api/logs` now supports multi-level, multi-server, date range, text, regex (validated, length-bounded, nested-quantifier rejection, 250 ms vm time box), sort and pagination, with `meta` (applied filters, total, truncated, windowCap, scope) and the `logs.search` audit event carrying the filters. Mock and Urbani-API adapters filter in-process; a new CloudWatch Logs Insights adapter (LOGS_SOURCE=insights) is built behind config and tested with a mocked SDK only. Logs page has the full filter bar, chips, URL sync and scope/truncation notices. CDK task-role IAM authored, not deployed. Tests: 347 passed / 83 skipped; build, frontend typecheck, infra tsc and a port-4100 smoke pass.
- **Pending client input:** log group names/ARNs + read access for QA/Main/Payment, or an Urbani `/logs` API extension. Logs Insights NOT exercised against real AWS.
- **Report:** [item-04-report.md](item-04-report.md)

### 2026-11-06: item #5 (MFA + SSO): DONE (integration pending)

- **Commit on `dpi2`:** `52279c5` (on top of `21bb34e`; not pushed).
- **Summary:** TOTP MFA (RFC 6238, AES-256-GCM secrets, recovery codes, lockout, replay guard, `MFA_REQUIRED_ROLES` policy, enrol/verify/disable/regenerate/reset endpoints, audit actions, Login/Security/Users UI) works with no client input. OIDC SSO (auth code + PKCE, in-repo ID-token validation, group-to-role map, auto-provision, `AUTH_PROVIDER`/`AUTH_LOCAL_ENABLED`) and a Cognito CDK construct (off by default, not deployed) are built behind config. Tests: 395 passed / 86 skipped; build, frontend typecheck, infra tsc + check and a port-4100 smoke pass. OIDC tested only against a local fake provider; UI not exercised in a browser; DynamoDB-gated cases not run (Docker daemon down).
- **Pending client input:** Google Workspace admin access, group-to-role mapping, SSO vs TOTP decision, `MFA_REQUIRED_ROLES` policy, `MFA_ENCRYPTION_KEY` + `OIDC_CLIENT_SECRET` in Secrets Manager, Cognito domain/callback URLs.
- **Report:** [item-05-report.md](item-05-report.md)

### 2026-11-06: item #6 (automatic alerts: e-mail, Slack, Teams): DONE (integration pending)

- **Commits on `dpi2`:** `064831c` (backend, shared, infra, docs) and `906d3ca` (frontend), on top of `52279c5`; not pushed.
- **Summary:** In-process notification engine in the backend (deliberate deviation from the proposed Streams + Lambda design, for client confirmation) with rules, atomic conditional claims for dedup across tasks, hourly rate cap, delivery log + retention, SNS/Slack/Teams adapters (SSRF allow-list, retries, URL redaction), background poller with first-run watermark, `/api/notifications` API (`alerts:view` read, `alerts:rules` mutate/test, audited, test-send rate limited), Notifications page and opt-in SNS IaC. Tests: 468 passed / 95 skipped; build, frontend typecheck, infra tsc + check pass; DynamoDB Local contract 168/168; port-4100 dry-run smoke OK. No real SNS/Slack/Teams delivery exercised; UI not tried in a browser.
- **Pending client input:** alert e-mails, Slack/Teams webhook URLs, real rules + dedup window, dashboard URL, OK for in-process design, AWS account/region.
- **Report:** [item-06-report.md](item-06-report.md)

### 2026-11-06: items #7 and #8 (chat feedback + history, AI latency): DONE (integration pending)

- **Commits on `dpi2`:** `0c51d29` (backend, shared, docs) and `f9db7c2` (frontend), on top of `906d3ca`; not pushed.
- **Summary:** Chat exchanges are stored per user (owner-only; others get 404, Super Admin included) with resume via `sessionId`, history API (list/get/rename/delete), like/dislike feedback with comment redaction, a de-identified quality summary (`audit:view`), `CHAT_HISTORY_ENABLED` and `CHAT_RETENTION_DAYS` (placeholder 90) with a daily purge and one summary audit event. End-to-end latency (monotonic clock; total/provider/preparation) is stored, returned, logged, audited as numbers and shown in the UI with a live timer and slow hint; quality card on AI Insights. Tests: 487 passed / 99 skipped; DynamoDB Local chat contract 28/28; build, frontend typecheck and a smoke on a local SQLite DB pass. Real Urbani /chat latency and the browser UI were NOT exercised.
- **Pending client input:** chat retention period, PII/privacy policy for stored questions, whether auditors may ever read chat content (currently no).
- **Report:** [item-07-08-report.md](item-07-08-report.md)

### 2026-11-06: items #9 and #10 (health panel, branding + dark mode, UI smoke): DONE (integration pending)

- **Commits on `dpi2`:** `cedfb2a` (backend, shared, infra, docs) and `f20276a` (frontend, branding, dark mode, contrast, UI smoke), on top of `f9db7c2`; not pushed.
- **Summary:** Config-driven health probes (SSRF-guarded, stored via repositories, uptime with insufficient-data rule), `/api/health/*`, Service Health page + Dashboard strip, Route 53/Synthetics IaC behind a flag; placeholder brand module, system/light/dark theme with per-user preferences API and WCAG contrast check; `scripts/ui-smoke.mjs` (Edge over CDP) passed 37/37 in light+dark and found one real crash (fixed). Tests 577 passed / 104 skipped.
- **Pending client input:** QA/Main/Payment health URLs + network reachability; official logo, palette, dark-mode guidance.
- **Report:** [item-09-10-report.md](item-09-10-report.md)
### 2026-11-07: items #11 + #12 (export; dashboard personalization): DONE (integration pending)
- **Commits on dpi2:** 90f1a77 (export) and 23385fb (dashboard widgets), on top of f20276a; not pushed.
- **Summary:** Streamed CSV/JSON/PDF exports for logs, CSV/JSON for alerts and an incident PDF (logs:export, rate limited, audited, provenance/scope/truncation in every file); per-user rearrangeable Dashboard widgets (shared registry, normalizeLayout, widgetLayout in preferences, Customize UI). Tests 619 passed / 104 skipped; build, frontend typecheck and UI smoke 43/43 pass.
- **Pending client input:** export size limits / S3 for large exports, retention of exported files, whether auditors may export, widgets in scope.
- **Report:** [item-11-12-report.md](item-11-12-report.md)

### 2026-11-07: item #13 (load + performance tests): DONE (integration pending)
- **Commit on dpi2:** 1684a54 (on top of 23385fb; not pushed).
- **Summary:** MOCK_LOG_VOLUME synthetic logs (mock-only, non-production), shared scenarios.json + thresholds.json (DRAFT), zero-dependency Node runner, k6 script + DLT standalone bundle, scripts/ui-perf.mjs, docs/LOAD_TESTING.md. Ran locally: realistic 50 VUs on 50k lines and search-heavy on 200k pass the draft SLOs; UI perf passes. Fixed ALB keep-alive timeout. Tests 638 passed / 104 skipped.
- **Pending client input:** agreed SLOs, expected users and peak log rate, permission and target environment for DLT. k6, DLT, ALB/Fargate and DynamoDB comparison not exercised.
- **Report:** [item-13-report.md](item-13-report.md)

### 2026-11-10: item #14 (deployment readiness, authored not executed): DONE (integration pending)
- **Commits on `dpi2`:** `5f8a457` (nginx template / compose / Dockerfile), `ceb75cf` (deploy-ecs-dpi2.sh, redeploy-dpi2.sh, deploy/ config, check:deploy), `ea9c56a` (runbook, go-live matrix, integration plan); not pushed, `main` unchanged.
- **Summary:** DPI 2 deploys as a PARALLEL ECS service (dpi2.urbani.io, priority 401, DynamoDB, 2 tasks / 2 AZs, autoscaling) via new scripts that are dry-run by default and need APPLY=1 + CONFIRM_ACCOUNT. Config in deploy/dpi2.env.example, cross-checked by `npm run check:deploy` (also a backend test). nginx upstream is now configurable (fixes a compose 502). Verified: build, 641 passed / 104 skipped, frontend tsc, bash -n, dry-run with 0 aws/docker/openssl calls, stub-aws apply path, real local Docker builds and runs (SQLite, DynamoDB Local, shared-namespace nginx, compose), secret scan clean. **NOTHING was executed against AWS; scripts are unproven on a real account.**
- **Pending client input:** deploy approval, operator credentials, network/ALB confirmation, hostname/DNS approval, rotated Urbani API key, plus everything in docs/DPI2_GO_LIVE_MATRIX.md.
- **Report:** [item-14-report.md](item-14-report.md)

### Final verification (orchestrator, independent run)
- Branch `dpi2` HEAD `a047183`; `main` untouched at `5cc5ffa`; nothing pushed.
- `npm run build` exit 0; `npm test` 641 passed / 104 skipped (the 104 are DynamoDB-gated and passed separately against DynamoDB Local per item reports); frontend `tsc` exit 0; `npm run check:deploy` OK.
- Repo hygiene finding (pre-existing, DPI 1): `packages/backend/data/*.sqlite-wal|-shm` are tracked on `main` AND `origin/main` (4.1 MB + 1.9 MB WAL files containing bcrypt hashes, emails, alert ids and real QA wallet log text). Untracked + ignored on `dpi2` in `a047183`. Decision pending for `main`/history (see DPI2_INTEGRATION_PLAN.md).
- Nothing in DPI 2 has been run against AWS. All 14 items are DONE (integration pending).
