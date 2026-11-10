# Urbani "Radar UrbiNexus" — DPI 2 Plan, Gap Analysis & Client Requirements

_Source documents read in full:_
- `DPI2_Urbani_UrbiNexus_EN.docx` — the formal DPI 2 scope (objectives, success criteria, technical description, architecture, 13‑item backlog, prerequisites, checklists, logistics).
- `Upgrades_UrbiNexus_DPI_EN.pdf` — the MVP‑review improvement proposal that motivates DPI 2 (UI/UX, security/RBAC, log management, chatbot evaluation, KPIs).

_This document maps those requirements against the system we actually delivered in DPI 1, states precisely what changes, what is new, and exactly what we need from the client. It preserves the DPI 1 honesty rule: nothing is described as done that is not done; every data surface stays labelled LIVE / MOCK / WAITING_FOR_INTEGRATION._

---

## 1. Executive summary

DPI 2 takes the DPI 1 MVP (a working, honest observability dashboard on the Urbani QA environment, a Bedrock Nova 2 Lite incident pipeline, and the read‑only AI Copilot) and turns it into a **secure, multi‑user, multi‑service control center ready to scale**. The headline changes:

- **Security becomes real multi‑user:** granular RBAC (4 roles), SSO + MFA (Cognito / Google Workspace), and an audit log of sensitive actions. Today we have single‑level JWT auth with one bootstrap admin.
- **Persistence moves off SQLite to DynamoDB:** this removes the single‑writer limit and lets us run 2+ ECS tasks across AZs. Today we run exactly one task because SQLite is single‑writer.
- **Log management gets serious:** severity/server/date/text/regex filtering, full‑stream search (CloudWatch Logs Insights), and CSV/JSON/PDF export. Today `/logs` returns only "relevant" (flagged) lines and we surface alert‑evidence lines; there is no full‑stream search or export.
- **Monitoring expands from QA to Main + Payment** (subject to client access), plus a health/uptime panel and alert notifications to email + Slack/Teams.
- **Chatbot gets evaluation + memory:** like/dislike feedback, conversation history, and a visible end‑to‑end latency metric.
- **UX gets brand + dark mode + rearrangeable widgets.**

The DPI 2 document estimates **64 h of effort (~4 builders × 2 days)** across a 13‑item backlog (P0/P1/P2). A large fraction of the work is **blocked on client inputs** — identity‑provider access, Main/Payment log access, notification webhooks, and branding assets. Those are called out in Section 6.

**Honest status note for the client conversation:** several items in the DPI 2 "Already exists (DPI 1)" list describe the _target production shape_ (ECS Fargate + ALB + Route 53, DynamoDB alert pipeline). In our delivered DPI 1 the dashboard runs on ECS Fargate, but the running app persists to **SQLite**, and the incident/alert pipeline Lambdas are **CDK scaffolding (placeholders), not deployed**. DPI 2 is where DynamoDB persistence and the notifier pipeline actually get built. This is flagged per item in Section 4 so we do not over‑claim the starting point.

---

## 2. What DPI 2 asks for (faithful summary)

### 2.1 Objectives (from the scope doc)
1. **Security & access control** — move from single access level to granular RBAC, with SSO/MFA and an audit log.
2. **Log management & monitoring** — advanced filters + real‑time search (severity, server QA/Main/Payment, date range, keywords/regex), export (CSV/JSON/PDF), and automatic alerts by email, Slack or Teams.
3. **AI chatbot** — measure usefulness (feedback), keep conversation history, show response latency.
4. **Infrastructure KPIs** — health‑check/uptime panel for QA, Main, Payment; validate the UI stays smooth under load.
5. **User experience** — Urbani corporate identity (logo + palette), dark mode, personalizable dashboard widgets.
6. **Traceability** — verify the full deliverable sequence for 100% roadmap coverage.

### 2.2 Success criteria (the DPI is "successful if…")
- A user authenticates via **SSO/MFA** and operates only with their role's permissions; a Reader/Auditor cannot modify configuration (validated with per‑role test cases).
- Configuration actions and sensitive queries are recorded in the **audit log** with user, action, timestamp.
- Logs can be **filtered** (severity, server, date), **searched** (text/regex), and **exported** (CSV, JSON, PDF).
- A critical failure (real or simulated) generates an alert **by email and in at least one of Slack/Teams**.
- Every chatbot response allows a **like/dislike**, previous sessions can be consulted, and **latency is shown**.
- The status panel reflects **QA, Main, Payment** health; where there is no source access, the surface is **MOCK / WAITING_FOR_INTEGRATION**, never LIVE.
- The UI stays smooth under a **load test** with massive log generation (thresholds TBD with Urbani).
- The **DPI 1 provenance model is preserved** — no fabricated data or answers.

### 2.3 Roles to implement (RBAC)
- **Super Admin**
- **Infrastructure Administrator**
- **QA Operator**
- **Reader / Auditor**

---

## 3. What we delivered in DPI 1 (baseline)

| Area | DPI 1 delivered state |
|---|---|
| Dashboard | React 18 + Vite SPA served by nginx; Node 20 + Express API. Runs as a single ECS Fargate task behind an ALB. |
| Auth | JWT (signed), bcrypt‑hashed passwords, one seeded bootstrap admin. **Single access level** (no roles). |
| Persistence | **SQLite** (`better-sqlite3`) at `/data/urbani.sqlite` on a mounted volume. Single‑writer → **one task only**. |
| Live logs | `HttpUrbaniLogsAdapter` reads QA `/logs/latest` + `/logs/history`. Upstream returns only "relevant" lines; real lines are surfaced from **alert evidence** and merged into the Logs view. |
| Live incidents | `HttpUrbaniAlertsAdapter` reads QA `/alerts/latest` + `/alerts/history`; evidence correlated to logs; **confidence derived from severity** and labelled "(derived)". |
| AI Copilot | `HttpUrbaniChatProvider` → QA `POST /chat` (Bedrock Nova 2 Lite), grounded server‑side on recent logs + alerts. Advisory, read‑only. Shows a grounding note. **No feedback, no history, no latency metric.** |
| Metrics / Services | **MOCK** (QA exposes no endpoints). Labelled honestly. |
| Provenance | `SourceBadge` LIVE / MOCK / WAITING_FOR_INTEGRATION across every surface. No fabrication. |
| Secrets | `JWT_SECRET` + `URBANI_API_KEY` in AWS Secrets Manager via the deploy script. |
| Incident pipeline (CDK) | EventBridge→Collector→Bedrock→Alert Writer→DynamoDB is **written as CDK constructs with placeholder Lambdas; not deployed**. The running app does not use it. |
| Scope of services | **QA only** (`main`, `payments` under QA). Main/Payment as separate monitored servers are **not** wired. |
| Tests | Backend vitest suite (adapters, services, auth, correlation, chat grounding). Frontend strict typecheck. |

---

## 4. Gap analysis — per DPI 2 backlog item

Legend: **Status now** = where DPI 1 leaves us. **Delta** = the concrete work. **Blocked on** = client input required (see Section 6).

### Item 1 — Migrate persistence SQLite → DynamoDB (P0, 5 h)
- **Status now:** SQLite only; `DB_DRIVER=dynamodb` is a reserved enum but **no DynamoDB adapter exists** (the "mock DynamoDB" writes to SQLite). CDK defines an `UrbaniAlerts` table, not deployed.
- **Delta:** Implement a real DynamoDB adapter behind the existing repository/adapter boundary for **users & preferences, audit, chat history, feedback** (and optionally alerts). Design single‑table or per‑entity tables + keys/GSIs. Remove the single‑writer constraint so the service can run ≥2 tasks. Migrate/seed the admin + reference data. Keep the `Sourced<T>` contract unchanged.
- **Blocked on:** AWS account/region + permission to create DynamoDB tables; decision on single‑table vs multi‑table; data‑retention policy.
- **Risk:** medium. Touches every repository; needs careful key design and tests. The repository layer already isolates SQL, which helps.

### Item 2 — RBAC: 4 roles across API + UI (P0, 6 h, depends on 1)
- **Status now:** single access level; `requireAuth` guards routes but there is **no role/permission model**.
- **Delta:** Define the 4 roles + a permission matrix; add role to the user model (DynamoDB); enforce per‑route authorization middleware in the backend; gate UI actions/nav by role; add per‑role test cases (a Reader/Auditor must not be able to mutate config).
- **Blocked on:** client sign‑off on the exact permission matrix (what each role may see/do).
- **Risk:** medium. Must be enforced server‑side, not just hidden in the UI.

### Item 3 — SSO (SAML/OIDC, Google Workspace) + MFA (P1, 5 h, depends on 2 + IdP access)
- **Status now:** none. JWT local login only.
- **Delta:** Stand up **Amazon Cognito** federated with **Google Workspace** (SAML/OIDC); map IdP groups → the 4 roles; backend validates the Cognito token and enforces permissions. **Documented alternative** (per the scope doc): keep existing JWT and add **TOTP MFA** — lighter, no IdP dependency. We should get the client to pick.
- **Blocked on:** administrative access to Urbani's Google Workspace (or chosen IdP) to configure federation + MFA; group‑to‑role mapping.
- **Risk:** medium‑high. External IdP integration is the single most access‑dependent item; if IdP access slips, fall back to the JWT+TOTP alternative to still hit the "MFA" success criterion.

### Item 4 — Audit logs for config + sensitive queries (P0, 4 h, depends on 1,2)
- **Status now:** DPI 1 has an audit repository and records some intent (e.g. settings PUT), stored in SQLite and labelled MOCK.
- **Delta:** Persist audit events to DynamoDB with **user, action, timestamp** for all configuration changes and sensitive queries; expose in the Audit view; optionally mirror infra‑level events via CloudTrail. Make it role‑aware.
- **Blocked on:** which actions count as "sensitive" (client definition); retention period.
- **Risk:** low‑medium.

### Item 5 — Advanced filters + search: severity, server, dates, text/regex (P0, 6 h, depends on Main/Payment access)
- **Status now:** Logs view filters the **current window only** (level/service/text) over the lines we can get. There is **no full‑stream search and no regex**, because QA `/logs` returns only flagged lines.
- **Delta:** Add severity/server/date‑range/text/**regex** parameters to the `/logs` API with **pagination**. For full‑stream search (beyond flagged lines) integrate **CloudWatch Logs Insights** queries, _or_ get the Urbani `/logs` endpoint extended to return the full stream. This is the pivotal technical decision for this item.
- **Blocked on:** read access to the underlying CloudWatch log groups (and for Main/Payment, access at all); confirmation of which approach (Logs Insights vs extend the Urbani API).
- **Risk:** medium‑high. Depends on data access we do not currently have; regex over large streams has cost/perf implications.

### Item 6 — Export logs/reports: CSV, JSON, PDF (P1, 4 h, depends on 5)
- **Status now:** none.
- **Delta:** Backend export endpoints producing CSV, JSON, and PDF from a filtered query; stream large exports; optionally stage large files in **S3** with a signed URL. (We already have a working PDF generator pattern in `scripts/gen-docs.js` to reuse for server‑side PDF.)
- **Blocked on:** S3 bucket (if used); max export size / retention policy.
- **Risk:** low‑medium (PDF of very large result sets needs pagination/streaming).

### Item 7 — Automatic alerts: email + Slack + Teams (P1, 6 h, depends on 1 + client webhooks)
- **Status now:** none. Alerts are shown in‑app only.
- **Delta:** **DynamoDB Streams → Lambda Notifier → SNS (email)** + **Slack/Teams webhooks** (URLs in Secrets Manager). Rules by **severity and service**, with **deduplication** so one incident does not spam. Must fire on a real or simulated critical failure (a success criterion).
- **Blocked on:** destination email addresses; authorized Slack and/or Teams **webhook URLs**; severity thresholds that should notify.
- **Risk:** medium. Dedup + rate control matter; webhooks are client‑provided.

### Item 8 — Chatbot feedback (like/dislike) + conversation history (P1, 6 h, depends on 1)
- **Status now:** Copilot answers are stateless per session; no feedback capture, no persisted history.
- **Delta:** Persist chat sessions + messages to DynamoDB keyed by user; add like/dislike capture per answer; allow resuming previous sessions in the UI.
- **Blocked on:** history retention policy; privacy stance on storing questions (PII).
- **Risk:** low‑medium.

### Item 9 — AI latency metric visible in chat (P1, 3 h)
- **Status now:** not surfaced.
- **Delta:** Measure **end‑to‑end** latency (includes the Urbani `/chat` round‑trip, not just the model) and display it per answer; optionally emit to CloudWatch for trends.
- **Blocked on:** nothing (self‑contained).
- **Risk:** low. Good early‑win / warm‑up task.

### Item 10 — Health/uptime panel: QA, Main, Payment (P1, 5 h, depends on Main/Payment access)
- **Status now:** no health panel; Metrics/Services are MOCK.
- **Delta:** **CloudWatch Synthetics** canaries + **Route 53 health checks** per service; Container Insights for the dashboard itself; a status panel with real‑time indicators. Where a source is inaccessible, show **MOCK / WAITING_FOR_INTEGRATION**, never LIVE (success criterion).
- **Blocked on:** where Main/Payment actually run and how to probe them (endpoints/health URLs); access.
- **Risk:** medium. Entirely gated on knowing + reaching the Main/Payment services.

### Item 11 — Corporate branding + dark mode (P1, 4 h, depends on brand assets)
- **Status now:** generic theme; we have a gold/dark palette used in generated docs, but no official assets in the app header/nav.
- **Delta:** Apply official **logo** in header/nav and **corporate palette**; implement a **dark mode** toggle; persist the choice per user (preferences in DynamoDB).
- **Blocked on:** official logo + palette in SVG/PNG with hex values.
- **Risk:** low.

### Item 12 — Dashboard personalization: rearrangeable widgets (P2, 4 h, depends on 1)
- **Status now:** fixed layout.
- **Delta:** Draggable/rearrangeable widgets with per‑user layout persisted in DynamoDB preferences.
- **Blocked on:** which widgets are in scope for rearrangement.
- **Risk:** low‑medium (UI state + persistence).

### Item 13 — Load tests for dashboard + API (P2, 4 h, depends on 5,7)
- **Status now:** none.
- **Delta:** **Distributed Load Testing on AWS** (or **k6**) against the ALB and API; validate UI fluidity under massive log generation; extend the automated suite to cover roles, auditing and the new adapters.
- **Blocked on:** agreed **load thresholds / SLOs** (explicitly "to be defined with Urbani").
- **Risk:** low‑medium. Needs the other items present to be meaningful.

### Cross‑cutting (from "Already exists, but changes")
- **CloudWatch ingestion extended QA → Main + Payment** — gated on client access (touches items 5, 10).
- **ECS operations:** Service Auto Scaling (≥2 tasks across 2 AZs) + least‑privilege Task Role for DynamoDB/SNS/CloudWatch — unblocked once Item 1 (DynamoDB) removes the single‑writer limit.

---

## 5. Consolidated upgrade roadmap (what we build, in order)

Ordered by dependency and priority (P0 first). Effort figures are the scope doc's estimates.

1. **(P0) DynamoDB persistence** [Item 1, 5 h] — foundation for roles, audit, chat history, preferences, multi‑task.
2. **(P0) RBAC — 4 roles, API + UI** [Item 2, 6 h].
3. **(P0) Audit logging** [Item 4, 4 h].
4. **(P0) Advanced log filters + search (Logs Insights/regex)** [Item 5, 6 h] — _access‑gated_.
5. **(P1) SSO + MFA (Cognito/Google) or JWT+TOTP fallback** [Item 3, 5 h] — _IdP‑gated_.
6. **(P1) Alerts to email + Slack/Teams** [Item 7, 6 h] — _webhook‑gated_.
7. **(P1) Chat feedback + history** [Item 8, 6 h].
8. **(P1) AI latency metric** [Item 9, 3 h] — quick win, can start day 1.
9. **(P1) Health/uptime panel QA/Main/Payment** [Item 10, 5 h] — _access‑gated_.
10. **(P1) Branding + dark mode** [Item 11, 4 h] — _asset‑gated_.
11. **(P1) Log/report export CSV/JSON/PDF** [Item 6, 4 h].
12. **(P2) Dashboard widget personalization** [Item 12, 4 h].
13. **(P2) Load tests + extended automated suite** [Item 13, 4 h] — _threshold‑gated_.

**Total: ~64 h.** New AWS services introduced in DPI 2: **Cognito, DynamoDB (as the live store), DynamoDB Streams, Lambda Notifier, SNS, CloudWatch Synthetics, Route 53 health checks, Container Insights, S3 (export), Distributed Load Testing / k6.**

---

## 6. What we need FROM THE CLIENT (detailed)

These are the inputs that unblock the backlog. Items are grouped; each names the backlog items it unblocks and whether it is a **hard blocker** (work cannot start) or **soft** (work can start with a MOCK/placeholder and be flipped to LIVE later).

### 6.1 Access & identity (hard blockers)
1. **AWS account/region + permissions** for the DPI (create DynamoDB, Cognito, SNS, Lambda, CloudWatch Synthetics, S3, IAM roles). _Unblocks:_ 1,3,4,7,10,13. **Hard.**
2. **Identity Provider admin access** — administrative access to **Google Workspace** (or the chosen IdP) to configure SAML/OIDC federation + MFA, _plus_ the **group→role mapping** (which Google groups map to Super Admin / Infra Admin / QA Operator / Reader‑Auditor). _Unblocks:_ 3. **Hard** (or confirm the **JWT + TOTP** fallback instead).
3. **Read access to Main and Payment** server logs/metrics (in addition to QA) — or an explicit decision to treat them as **MOCK/WAITING_FOR_INTEGRATION**. Include **where those services run** and how to probe their health. _Unblocks:_ 5,10 and the QA→Main/Payment ingestion. **Hard for LIVE; soft if MOCK is accepted.**
4. **CloudWatch log group names/ARNs** for QA/Main/Payment and confirmation we may run **Logs Insights** queries against them — _or_ agreement to **extend the Urbani `/logs` API** to return the full stream (not just flagged lines). _Unblocks:_ 5,6. **Hard** for full‑stream search.

### 6.2 Notification channels (hard blocker for Item 7)
5. **Destination email address(es)** for alerts (for SNS subscription/confirmation).
6. **Authorized Slack webhook URL** and/or **Microsoft Teams webhook URL** (to be stored in Secrets Manager).
7. **Alert rules:** which **severities/services** should notify, and the **dedup window** (e.g. suppress repeats within N minutes).

### 6.3 Branding & UX (blocks Item 11; soft — can theme generically first)
8. **Official Urbani logo** (SVG + PNG) for header/nav.
9. **Corporate color palette** with exact hex values (primary/secondary/dark‑mode variants).
10. Any **dark‑mode** brand guidance (if different from a straight inversion).

### 6.4 Decisions & definitions (needed to design correctly)
11. **RBAC permission matrix** — confirm exactly what each of the 4 roles may **view** and **do** (especially what a Reader/Auditor is forbidden from). _Unblocks:_ 2,4.
12. **SSO vs JWT+TOTP** — pick the authentication approach (affects Item 3 scope and the IdP dependency).
13. **Audit scope** — which actions/queries count as "sensitive" and must be logged; **retention period** for audit, chat history, and exports.
14. **Load/performance thresholds (SLOs)** for Item 13 — the doc explicitly says these are "to be defined with Urbani" (e.g. target p95 UI latency, concurrent users, log‑generation rate).
15. **Data privacy** — confirmation that stored chat history / exported logs are **PII‑free or de‑identified** (the prerequisites checklist calls out PII removal and GDPR/HabeasData); encryption‑at‑rest via KMS is assumed.

### 6.5 Security carried over from DPI 1 (must close before go‑live)
16. **Rotate the previously shared Urbani API key** and store the new value in Secrets Manager.
17. **Replace the bootstrap admin password** with a strong secret in Secrets Manager (currently the dev default is in use on the live task — this is a standing security flag from DPI 1).

### 6.6 Logistics / sponsorship (from the DPI 2 prerequisites)
18. **Named Urbani sponsor** (the scope doc leaves this "to be confirmed").
19. **Confirmed builders** (the doc assumes ~4 builders over 2 days), DPI dates, and room/virtual‑collab setup.
20. **Code repository** access (GitHub/CodeCommit) and IAM for builders; Bedrock model access confirmed; AWS Budgets/cost alerts enabled.

---

## 7. Open questions / ambiguities to resolve at kickoff

- **Full‑stream log search approach:** CloudWatch Logs Insights vs. extending the Urbani `/logs` API. This single decision drives Items 5, 6 and the Main/Payment access ask. _Recommendation:_ prefer Logs Insights if we get log‑group access (no upstream API change needed); otherwise request the API extension.
- **Auth path:** Cognito+Google (full SSO/MFA, heavier, IdP‑dependent) vs. JWT+TOTP (lighter, no IdP). _Recommendation:_ Cognito if IdP access is granted in time; otherwise JWT+TOTP to still meet the MFA success criterion.
- **DynamoDB data model:** single‑table vs per‑entity tables for users/preferences/audit/chat/feedback (and whether alerts also move off the mock store). _Recommendation:_ decide at kickoff based on access patterns; single‑table favors cost/perf, per‑entity favors clarity.
- **Main/Payment reality:** are these real, reachable services for LIVE health + logs, or do they stay MOCK for DPI 2? This caps how much of Items 5 and 10 can be LIVE.
- **Alerts channel minimum:** the success criterion requires **email + at least one of Slack/Teams** — confirm which messaging platform Urbani will provide a webhook for.
- **Starting‑point honesty:** align with the client that DPI 2 is where **DynamoDB persistence and the notifier pipeline are actually built/deployed** (DPI 1 delivered them as SQLite + CDK scaffolding), so expectations match reality.

---

## 8. Suggested DPI 2 kickoff checklist (one page for the sponsor)

- [ ] AWS account + region + builder IAM confirmed; Bedrock access + Budgets on.
- [ ] Decision: **Cognito+Google SSO** or **JWT+TOTP**. If Cognito: Google Workspace admin access + group→role map provided.
- [ ] Decision: **Logs Insights** access (log‑group ARNs for QA/Main/Payment) or **Urbani `/logs` API extension**.
- [ ] Main/Payment: LIVE access granted, or agreed as MOCK for DPI 2.
- [ ] Notification: alert email(s) + Slack/Teams webhook(s) + severity rules + dedup window.
- [ ] Branding: logo (SVG/PNG) + palette hex + dark‑mode guidance.
- [ ] RBAC permission matrix signed off; audit "sensitive action" list + retention defined.
- [ ] Load‑test thresholds/SLOs agreed.
- [ ] Data confirmed PII‑free/de‑identified; KMS encryption expectations confirmed.
- [ ] DPI 1 carry‑overs scheduled: rotate API key, replace bootstrap admin password.
- [ ] Sponsor named; builders + dates + rooms/collab tools + repo confirmed.

---

_Prepared from the two client documents and the delivered DPI 1 codebase. Effort estimates, owners, and the final architecture (Cognito, DynamoDB, SNS/Slack/Teams, Synthetics) are per the DPI 2 scope doc and will be confirmed with Urbani at kickoff; ingestion from Main and Payment depends on source access._
