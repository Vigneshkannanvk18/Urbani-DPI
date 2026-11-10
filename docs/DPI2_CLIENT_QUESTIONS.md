# Radar UrbiNexus (DPI 2): questions for Urbani

**From:** DPI development team · **Date:** 28 October 2026 · **Status:** waiting for answers

These questions collect the access, decisions and definitions that DPI 2 depends on. Each question names the backlog item it unblocks (numbering from the DPI 2 scope document, #1 to #13) and the default we will build with if there is no answer when the DPI starts. Until a real source or decision arrives, the related screens stay labelled MOCK or WAITING_FOR_INTEGRATION. Nothing is shown as LIVE without real data.

The AWS permissions we need are in `docs/iam/`, with an overview in `docs/iam/README.md`. When an answer changes one of those files, the question says so.

**How to answer:** write your answer under each question, or reply "default accepted". The sections are grouped by the team best placed to answer them.

## Answer these first

These block the most work or need lead time on your side:

- **A1 to A3:** the AWS account, the identity we use, and who manages IAM roles.
- **B1 to B3:** where Main and Payment run, their log groups, and read access to them.
- **C1 to C4:** the sign-in approach, the Google Workspace admin contact, 2-Step Verification, and the group-to-role mapping.
- **D1:** sign-off of the draft role matrix.
- **F1 to F3 and F8:** alert email addresses, the Slack or Teams webhook, and the alert source.

---

## A. AWS account, access and deployment

_For: Urbani cloud and infrastructure team_

**A1. Account and region.** Do we build DPI 2 in the same AWS account and region as DPI 1 (`701179923456`, `us-east-1`)? If you prefer a separate sandbox or dev account, which account and region?
_Unblocks:_ all AWS work. _Default:_ same account and region. The policies in `docs/iam/` already use them.

**A2. Our AWS identity.** Which identity will the builders use: the IAM principal behind the `urbani` CLI profile from DPI 1, an IAM Identity Center permission set, or a new role? Who on your side attaches the policies, and how much lead time do you need?
_Unblocks:_ all AWS work. _Default:_ the DPI 1 principal, with `builder-1` to `builder-3` attached.

**A3. Who manages IAM roles.** DPI 2 adds two roles (alert notifier and health canaries) and new permissions on the existing task and execution roles. Option A: your team applies our JSON files, and we never get IAM write access. Option B: we manage only roles named `urbaniqa-dpi-*`, capped by a permissions boundary we cannot change. Which do you prefer? Both are described in `docs/iam/README.md`.
_Unblocks:_ #1, #7, #10. _Default:_ Option A.

**A4. Deployment method.** Should we keep deploying with the AWS CLI scripts used in DPI 1, or move to AWS CDK (CloudFormation)? If CDK: is `us-east-1` already bootstrapped, and which execution policy should the bootstrap use?
_Default:_ the CLI scripts, as in DPI 1.

**A5. Shared infrastructure.** DPI 2 reuses what DPI 1 uses: cluster `urbaniqa-qa-observability-cluster`, load balancer `urbaniqa-qa-alb` with the host rule for `dpi.urbani.io`, the `urbani.io` hosted zone, the `*.urbani.io` certificate, and the VPC, subnets and security group you gave us. Is that still correct? The load balancer is shared with other QA services: are there change windows or restrictions we must respect?
_Default:_ reuse all of it. We do not change listener rules.

**A6. Availability and scaling.** May we run 2 tasks (one per Availability Zone) and add ECS Service Auto Scaling (minimum 2, maximum 4, target 60% CPU)? Is Container Insights enabled on the cluster? If not, will your team enable it? It is a cluster-wide setting with its own CloudWatch cost.
_Unblocks:_ ECS operations, #10. _Default:_ 2 tasks, auto scaling only if approved here, Container Insights enabled by your team.

**A7. Encryption at rest.** Are AWS-managed keys acceptable for DynamoDB, S3, SNS, SQS and Secrets Manager? If you require a customer-managed KMS key, will your team create it and send us the key ARN? Key administration stays with you.
_Unblocks:_ #1, #6, #7. _Default:_ AWS-managed keys. A customer-managed key adds the KMS statements in `docs/iam/README.md`.

**A8. Names and tags.** Can DPI 2 resources use the prefix `urbaniqa-dpi-` (secrets under `urbaniqa/dpi/`, DynamoDB table `UrbaniApp`) and the tag `Project=urbaniqa-dpi`? Do you require other tags, such as cost center, owner or environment? The policies are scoped to these names.
_Default:_ as listed, plus `Environment=qa`.

**A9. Budget.** What monthly budget applies to the DPI 2 resources, and who receives AWS Budgets alerts? Will your team create the budget?
_Default:_ a soft alert at USD 50 and a hard alert at USD 100 a month (the values in our DPI 1 infrastructure code), created by your team.

**A10. DPI 1 data.** Should DPI 2 keep the DPI 1 data: users, audit history, alert acknowledgements and AI analyses? It lives in a file inside the running task. Copying it out needs temporary ECS Exec access, which the policies include and which can be removed afterwards. The alternative is a fresh start: the admin account is recreated and LIVE alerts reload from your API, but acknowledgements and history are lost.
_Unblocks:_ #1. _Default:_ fresh start.

---

## B. Log sources and monitored servers (QA, Main, Payment)

_For: Urbani application and infrastructure teams_

**B1. Where Main and Payment run.** What runs Main and Payment (for example Elastic Beanstalk, ECS or EC2), and in which AWS account and region? Please include QA if it differs from what DPI 1 uses.
_Unblocks:_ #5, #10. _Default:_ Main and Payment shown as WAITING_FOR_INTEGRATION.

**B2. Log groups and log format.** Please send the exact CloudWatch log group names for QA, Main and Payment, and say which ones hold application logs (as opposed to web server or platform logs). Please also send 20 to 50 real log lines per server, with personal data removed, so we can build the severity and server filters on the real format.
_Unblocks:_ #5, #6. _Changes:_ replaces the placeholder `/aws/elasticbeanstalk/urbani-*` in `docs/iam/`. _Default:_ none. LIVE search needs this.

**B3. Read access to those logs.** Do you approve read-only CloudWatch Logs Insights access to the log groups in B2 (start a query, read results, filter events; no write)? If any of them are in another AWS account, which do you prefer: CloudWatch cross-account observability (linking that account to `701179923456`), or a read-only role in that account that the DPI can assume?
_Unblocks:_ #5, #6. _Default:_ same account, Logs Insights.

**B4. Alternative to Logs Insights.** If log group access is not possible, would your team extend the Urbani `/logs` API instead? It would need to return the full stream rather than only flagged lines, and accept a `from`/`to` time range, severity, server and pagination. Full-stream search needs either B3 or B4.
_Unblocks:_ #5, #6. _Default:_ B3.

**B5. Health endpoints.** Which URL should the uptime panel probe for QA, Main and Payment (for example `/health`)? What counts as healthy: status code, response body, maximum response time? Are these URLs public, or reachable only inside a VPC? If private, which subnets and security group should the probes use? Route 53 health checks only reach public endpoints, so private ones are probed by CloudWatch Synthetics canaries inside your VPC. Do the endpoints need an auth header, and could a WAF or rate limit block a probe every 5 minutes?
_Unblocks:_ #10. _Default:_ a probe every 5 minutes, without auth. A server without an endpoint shows WAITING_FOR_INTEGRATION.

**B6. Fallback.** If access to Main or Payment is not ready by the DPI dates, do you accept those screens staying MOCK or WAITING_FOR_INTEGRATION in the demo, as the scope document allows?
_Default:_ yes.

---

## C. Sign-in: SSO and MFA

_For: Urbani IT and the Google Workspace administrator_

**C1. Approach.** Which sign-in do you want for DPI 2?
(a) Amazon Cognito federated with Google Workspace: single sign-on with corporate accounts.
(b) Keep the DPI login and add one-time codes from an authenticator app (TOTP), with no dependency on your identity provider. The scope document lists (b) as the alternative.
_Unblocks:_ #2, #3. _Default:_ (a) if C2 is confirmed one week before the DPI, otherwise (b).

**C2. Google Workspace administrator.** Can a Google Workspace super administrator create a custom SAML app for the DPI, before or during the DPI? Who is the contact? Once the Cognito user pool exists, we send the two values the app needs (ACS URL and Entity ID).
_Unblocks:_ #3.

**C3. 2-Step Verification.** Is 2-Step Verification enforced in Google Workspace for everyone who will use the DPI? With federated sign-in, Cognito leaves MFA to Google, so the "SSO/MFA" success criterion depends on this setting.
_Unblocks:_ #3. _Default:_ we ask you to enforce it for the DPI groups.

**C4. Groups to roles.** Which Google groups map to each role: Super Admin, Infrastructure Administrator, QA Operator and Reader/Auditor? Can the SAML app send group membership? Google supports this in the app's attribute mapping. If a user is in more than one group, should the most privileged role apply?
_Unblocks:_ #2, #3. _Default:_ the most privileged role applies.

**C5. Who may sign in.** Only members of those groups, or anyone in the `urbani.io` domain, with Reader/Auditor as the default role?
_Default:_ group members only.

**C6. Where roles are managed.** Only in Google groups, or also inside the dashboard by a Super Admin? With option (b) in C1, roles are managed in the dashboard.
_Default:_ Google groups only. The dashboard shows roles read-only.

**C7. Session length.** How long may a session last before the user signs in again? DPI 1 uses 8 hours. Do you need an idle timeout?
_Default:_ 8 hours, no idle timeout.

**C8. Sign-in domain.** Is the default Cognito domain acceptable (`<prefix>.auth.us-east-1.amazoncognito.com`), or do you want a custom domain under `urbani.io`? A custom domain adds certificate and DNS work.
_Default:_ the Cognito default domain.

**C9. Emergency access.** May we keep one local Super Admin account (strong password plus TOTP, stored in Secrets Manager) for when Google sign-in is unavailable? Who should hold it?
_Default:_ yes, held by the sponsor.

---

## D. Roles and permissions

_For: Urbani product owner and security_

The table below is our **draft** permission matrix. It is not final until you sign it off.

| Capability | Super Admin | Infrastructure Admin | QA Operator | Reader / Auditor |
|---|---|---|---|---|
| View dashboard, alerts, logs, metrics, services and health panel | Yes | Yes | Yes | Yes |
| Filter and search logs (severity, server, dates, text, regex) | Yes | Yes | Yes | Yes |
| Personalize own dashboard layout and theme | Yes | Yes | Yes | Yes |
| Ask the AI Copilot, rate answers, see own chat history | Yes | Yes | Yes | Yes |
| Export logs and reports (CSV, JSON, PDF) | Yes | Yes | Yes | Yes |
| Run an AI analysis (AI Insights) | Yes | Yes | Yes | No |
| Acknowledge alerts | Yes | Yes | Yes | No |
| View the audit log | Yes | Yes | No | Yes |
| View usage and cost | Yes | Yes | No | Yes |
| Change alert rules and channels, send a test alert | Yes | Yes | No | No |
| Change integration and system settings (thresholds, retention) | Yes | Yes | No | No |
| Manage users and role assignments (only if roles are managed in the dashboard, C6) | Yes | No | No | No |

**D1. Matrix sign-off.** Please confirm or correct each cell.
_Unblocks:_ #2, #4.

**D2. Other users' chat history.** Is chat history private to each user, or may Super Admins or Auditors read other users' conversations, for example for quality review?
_Unblocks:_ #8. _Default:_ private to each user.

**D3. Exports.** Exported files leave the system. Should exports be limited to some roles or some servers (for example, no Payment exports for QA Operators)?
_Unblocks:_ #6. _Default:_ as in the matrix.

**D4. Visibility per server.** Should any role see only some servers (for example, QA Operators see QA only and not Payment)?
_Unblocks:_ #2, #5. _Default:_ every role sees all servers.

---

## E. Audit log

_For: Urbani security and compliance_

**E1. Sensitive actions.** Please confirm the list of actions recorded in the audit log. Each event records user, action, target, time and result. Our draft:

- sign-in, sign-out and failed sign-in;
- access denied (a user tried something their role does not allow);
- user and role changes;
- changes to settings, alert rules and notification channels, and test alerts;
- alert acknowledgements;
- exports (format, filters used, number of rows);
- full-stream and regex log searches (query, time range, servers);
- Copilot questions (who, when, which server and how long the answer took; the question text stays in the chat history).

Should viewing the audit log itself also be recorded?
_Unblocks:_ #4.

**E2. Retention.** How long must audit events be kept? Must they be impossible to delete, even for a Super Admin?
_Unblocks:_ #4. _Default:_ 365 days, with no delete function in the product.

**E3. AWS-level events.** Should the audit view also show AWS CloudTrail events about the DPI's own AWS resources, or only application events?
_Unblocks:_ #4. _Default:_ application events only, which is what the success criterion asks for.

---

## F. Alert notifications

_For: Urbani operations_

**F1. Email recipients.** Which addresses receive alerts? A distribution list is easier to maintain than individual addresses. Each address receives an AWS confirmation email and must click its link once before alerts arrive.
_Unblocks:_ #7.

**F2. Chat channel.** Slack, Microsoft Teams, or both? The success criterion needs email plus at least one of them.
- Slack: an incoming webhook URL from a Slack app installed in your workspace, bound to the target channel.
- Teams: a webhook created with the Teams Workflows app. Microsoft retired the classic "Incoming Webhook" connectors in Teams in May 2026, so connector URLs no longer work ([Microsoft 365 Developer Blog](https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/)).

_Unblocks:_ #7.

**F3. Handing over webhook URLs.** Anyone who has a webhook URL can post to your channel, so please do not send it by email or chat. Either your team stores it directly in Secrets Manager as `urbaniqa/dpi/slack-webhook` or `urbaniqa/dpi/teams-webhook`, or tell us which secure channel to use. Our build accounts can write these secrets but cannot read them back.
_Default:_ your team stores it.

**F4. Rules.** Which severities send a notification (for example CRITICAL and HIGH)? For which servers and services? Around the clock, or only during business hours, and in which time zone?
_Unblocks:_ #7. _Default:_ CRITICAL and HIGH, all servers, 24/7.

**F5. Repeats.** For how long should repeats of the same incident be suppressed? Do you also want a message when an incident is resolved?
_Default:_ 30 minutes, no "resolved" message.

**F6. Message content.** May a notification include log excerpts, which can contain sensitive data, or only a summary with a link to the dashboard?
_Default:_ summary and link only.

**F7. Demo.** For the success-criterion demo, may we trigger a simulated critical alert during the DPI? Which email and channel should receive it?
_Default:_ yes, sent to the recipients in F1 and F2.

**F8. Where alerts come from.** Your pipeline writes alerts to the DynamoDB table `UrbaniAlerts`. Is that table in `701179923456` / `us-east-1`?
(a) Our proposal: your team enables a DynamoDB stream on that table (new images only), and our notifier reads it. Your pipeline and its data do not change, and notifications go out seconds after an alert is written. The DPI cannot modify the table; it can only read the stream.
(b) If a stream is not possible: a scheduled function polls your `/alerts` API every 5 minutes, which delays notifications by up to 5 minutes.
_Unblocks:_ #7. _Default:_ (a). _Changes:_ (b) swaps the notifier permissions as described in `docs/iam/README.md`.

---

## G. AI Copilot, chat history and privacy

_For: Urbani product owner and privacy or legal team_

**G1. Retention.** How long do we keep chat history (questions, answers and ratings)?
_Unblocks:_ #8. _Default:_ 90 days.

**G2. Personal data.** Can logs, alerts or chat questions contain personal data, such as names, emails, ID numbers or payment data from the Payment server? If yes, must it be masked before it is stored, exported or sent to the AI, and which rules apply (for example GDPR or Habeas Data, as the scope document mentions)?
_Unblocks:_ #5, #6, #8. _Default:_ we treat logs as possibly containing personal data and store chat history encrypted, with no masking until you define the rules.

**G3. Copilot endpoint.** DPI 2 keeps using your QA `/chat` endpoint (Bedrock Nova 2 Lite), so we request no direct Bedrock access. Please confirm, and tell us about any rate limit or planned change on that endpoint. Should the Copilot also answer about Main and Payment? That needs a change to the endpoint on your side.
_Unblocks:_ #8, #9. _Default:_ QA only.

**G4. Latency target.** Is there a target answer time, for example under 10 seconds, that the latency indicator should compare against?
_Unblocks:_ #9. _Default:_ show the measured time only.

---

## H. Exports

_For: Urbani product owner and security_

**H1. Limits.** What is the largest export you need, in rows or time range?
_Unblocks:_ #6. _Default:_ up to 50,000 rows or 31 days per export.

**H2. Storage of large exports.** May large exports be stored briefly in an S3 bucket in your account (`urbaniqa-dpi-exports-701179923456`) and downloaded through a link that expires after 15 minutes? After how many days should files be deleted automatically?
_Unblocks:_ #6. _Default:_ yes, deleted after 7 days.

---

## I. Branding and dashboard

_For: Urbani marketing and product_

**I1. Logo.** Please send the official logo in SVG and PNG, in versions for light and dark backgrounds. May we also use it on the sign-in page?
_Unblocks:_ #11.

**I2. Colors and font.** Exact hex values for the primary, secondary and accent colors, plus success, warning and error colors if you have them. If there is a corporate font, its name and a license for web use.
_Unblocks:_ #11. _Default:_ a neutral palette until received.

**I3. Dark mode.** Any guidance for dark mode? Which theme should new users get: light, dark, or the operating system setting?
_Default:_ the operating system setting.

**I4. Widgets.** Which dashboard widgets may users move or hide? Should "reset to default" be available?
_Unblocks:_ #12. _Default:_ all dashboard cards, with reset available.

---

## J. Load test and performance targets

_For: Urbani infrastructure_

**J1. Targets.** The scope document leaves the load-test thresholds to be agreed with you. Our proposal: 50 concurrent users for 15 minutes, 95% of non-AI API calls under 1 second, an error rate under 1%, and a Logs view that stays responsive with 10,000 lines loaded. Please adjust.
_Unblocks:_ #13.

**J2. Permission and window.** The test reaches `dpi.urbani.io` through the load balancer shared with other QA services. May we run it? In which time window, at what maximum request rate, and whom do we notify?
_Unblocks:_ #13.

**J3. Tool.** We plan to run k6 from our own machines, which needs no AWS resources. If you prefer the "Distributed Load Testing on AWS" solution, your team would deploy it, because it creates many AWS resources through CloudFormation and needs broad permissions.
_Default:_ k6.

---

## K. Security items carried over from DPI 1

_For: Urbani security_

**K1. Urbani API key.** The API key was shared in plain text during DPI 1 and must be rotated before go-live. Who rotates it, and when? Please store the new value in the existing secret `urbaniqa/observability/api-key`. The DPI picks it up at its next deployment.

**K2. Bootstrap admin password.** We will replace the default admin password with a generated one stored in Secrets Manager (`urbaniqa/dpi/admin-password`). Who should hold it?

---

## L. Logistics

_For: the Urbani sponsor_

**L1. Sponsor.** Name and title of the Urbani sponsor. The scope document leaves it to be confirmed.

**L2. Dates and people.** DPI dates, format (in person or virtual), and the Urbani participants with their roles: product owner, builders, and the AWS and Google Workspace administrators on call.

**L3. Repository.** Which code repository should DPI 2 use (GitHub or CodeCommit), and who grants access?

**L4. Go-live approval.** Who approves deploying DPI 2 to `dpi.urbani.io` at the end of the DPI, in which change window, and who is the contact if we need to roll back?
