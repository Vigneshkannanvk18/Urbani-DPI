# Automatic alert notifications (DPI 2 item 6)

Urbani Radar notifies people by e-mail (Amazon SNS), Slack and Microsoft Teams when a new alert matches a rule. This page describes how it works, how to switch it on and what we still need from Urbani.

Status: built and tested with mocks and a dry-run sink. **No real SNS, Slack or Teams delivery has been exercised yet.** Default rules are a DRAFT pending client input #7.

## Architecture

```
Urbani QA API --(poll every ALERT_POLL_MINUTES)--> alertService.sync --> alerts table
                                                                       |
Alerts page load --> syncLiveAlerts --(new alerts)---------------------+--> notification engine (in the backend)
                                                                              |  rules -> channels
                                              claim(dedupKey, channel) <------+  (atomic conditional write)
                                                                              |
                          +---------------------+-------------------+---------+
                          v                     v                   v
                     SNS publish          Slack webhook        Teams webhook        -> delivery log (database)
```

- **Engine**: `packages/backend/src/notifications/` (`engine.ts`, `channels.ts`, `guard.ts`, `message.ts`, `runtime.ts`, `poller.ts`). It reads OPEN alerts from the store, evaluates enabled rules and sends through one adapter per channel. It never creates or changes alerts.
- **Poller**: started by `server.ts` when `NOTIFICATIONS_ENABLED=true` and `INTEGRATION_MODE=live`. In live mode alerts only reach the store when someone loads the Alerts page, so a timer calls the alert sync and then the engine. It never overlaps itself, is unref'd and stops on shutdown. The engine is also triggered after a live sync that stored alerts (at most every 15 s); double triggering is harmless because of the claims.
- **Storage**: rules, settings, claims and the delivery log live behind the repository layer (SQLite migration `004_dpi2_notifications.sql`, DynamoDB entities in the `UrbaniApp` table). Contract tests cover both drivers.

### Deliberate deviation from the DPI 2 proposal (client to confirm at kickoff)

The scope document proposes **DynamoDB Streams -> Lambda notifier -> SNS + webhooks**. We built the engine **in the backend process** instead:

- it works on both database drivers (Streams only exists on DynamoDB, so SQLite dev and the current DPI 1 deployment would have no notifier),
- it needs no extra AWS moving parts (no Lambda, no stream, no extra IAM or deployment pipeline),
- alerts in live mode come from polling the Urbani QA API, so a poller is needed anyway; a Streams trigger would only fire after something already wrote the alert.

Safety with 2 or more ECS tasks: every send is preceded by an atomic conditional write (claim) keyed by `(dedupKey, channel)`. SQLite uses `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, DynamoDB uses a conditional `PutItem`. Only the task that wins the claim sends. This is covered by a two-engine race test (SQLite) and a gated concurrent-claim contract case (DynamoDB).

Alternative if the client prefers the proposed design: a Lambda on the alerts table stream calling the same adapters. The engine and adapters are plain modules, so they can be reused there.

## Event types

- **ALERT_OPENED**: an alert id with status OPEN that has not been notified on a channel yet.
- **ALERT_ESCALATED**: when the severity of an alert that was already notified rises (for example HIGH to CRITICAL) and the alert still matches a rule, one follow-up is sent per channel, titled `[ESCALATED] [CRITICAL] ...` with the line "Severity increased since the previous notification for this alert." It uses the same permanent claim mechanism as the first notification (one claim per alert, channel and severity level, so it is safe with several backend tasks and needs no schema change). A fall followed by a rise back to a level that was already covered never re-notifies. An escalation bypasses the type dedup window (it is a new event for an alert that was already announced) but still counts towards the hourly cap. An alert that first matches a rule only after rising is a normal first notification, not an escalation. **It only fires if the upstream source re-sends an existing alert id with a higher severity**; whether the Urbani API does that (rather than issuing a new alert id) has not been confirmed.
- Never notified: acknowledged, resolved or dismissed alerts, and MOCK alerts (unless `NOTIFICATIONS_ALLOW_MOCK=true`, for demos).
- First run: alerts older than `NOTIFICATIONS_MAX_ALERT_AGE_MINUTES` (default 60) that predate the moment the engine first ran (the stored watermark) are never notified, so switching it on does not blast history. The newest 200 OPEN alerts per source are evaluated per run.

## Rules and settings

A rule has: name, enabled, minimum severity (LOW, MEDIUM, HIGH, CRITICAL), services (empty = all), anomaly types (empty = all) and channels (EMAIL, SLACK, TEAMS). If several rules match an alert, each channel is used once.

**DRAFT default rule** (seeded once, enabled): "Critical and High to all configured channels (DRAFT default)": HIGH and above, all services, all three channels. A channel that is not configured is only logged as `SKIPPED_NOT_CONFIGURED`. Deleting the rule does not bring it back.

Global settings (Notifications page, needs `alerts:rules`):

| Setting | Default | Meaning |
|---|---|---|
| dedupWindowMinutes | 30 | Same service + environment + anomaly type is notified at most once per window and channel. 0 disables it. |
| maxPerHourPerChannel | 30 | Hourly cap per channel (SENT, FAILED and DRY_RUN count). Over the cap: a `SKIPPED_RATE_LIMIT` entry. |

## Deduplication semantics

For each eligible alert and channel the engine claims, in order:

1. `alert:<alertId>:OPENED` on that channel, **permanent**. If it is already claimed the alert is silently skipped, so polls do not fill the log.
2. `type:<service>:<environment>:<anomalyType>` on that channel for `dedupWindowMinutes`. If it is already claimed the entry `SKIPPED_DEDUP` is logged.
3. The hourly cap, then the send.

A failed send keeps its claim (no retry storm); the log shows `FAILED` with the attempts made. Claims and log entries older than `NOTIFICATIONS_LOG_RETENTION_DAYS` are purged daily.

## Channels

| Channel | How | Retry |
|---|---|---|
| EMAIL | SMTP (Google Workspace) to `ALERT_EMAIL_TO` when `SMTP_HOST` is set; otherwise `sns:Publish` to `ALERT_SNS_TOPIC_ARN` (subject + plain text) | 3 attempts, exponential backoff, 5xx or network errors only; 10 s timeout |
| SLACK | POST to `SLACK_WEBHOOK_URL`, `text` + Block Kit `blocks` | same; no retry on 4xx |
| TEAMS | POST to `TEAMS_WEBHOOK_URL`, Adaptive Card message (default) or legacy MessageCard (`TEAMS_WEBHOOK_FORMAT`) | same; no retry on 4xx |

Message content: severity, service, environment, anomaly type, summary, probable cause (truncated to 300 characters), confidence (labelled `(derived)` for LIVE alerts, where the Urbani API reports no model confidence), time and a deep link `<DASHBOARD_BASE_URL or FRONTEND_URL>/alerts/<alertId>` (omitted if neither is set).

Example (plain text, also used for e-mail):

```
[CRITICAL] main: DatabaseConnectionTimeout

Severity: CRITICAL
Service: main
Environment: qa
Anomaly type: DatabaseConnectionTimeout
Time: 2026-11-06T10:00:00.000Z
Summary: Connection pool exhausted
Probable cause: Unclosed sessions
Confidence: 85% (derived)

Open in dashboard: https://radar.example.com/alerts/ALT-123
```

Test message: title `[TEST] Urbani Radar notification test`, anomaly type `SIMULATED`, summary starting with `SIMULATED:`. A test never creates an alert; it is logged with `isTest=true`.

## Delivery log

Fields: id, timestamp, alertId, ruleId, channel, status, attempts, error (redacted), providerMessageId, isTest, summary. Statuses:

| Status | Meaning |
|---|---|
| SENT | The provider accepted the message |
| FAILED | All attempts failed (or a 4xx) |
| DRY_RUN | `NOTIFICATIONS_DRY_RUN=true`: logged, not sent |
| SKIPPED_DEDUP | Suppressed by the dedup window |
| SKIPPED_RATE_LIMIT | Suppressed by the hourly cap |
| SKIPPED_NOT_CONFIGURED | "Not delivered: channel not configured" |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| NOTIFICATIONS_ENABLED | false | Master switch for the poller and the post-sync trigger |
| NOTIFICATIONS_DRY_RUN | false | Forces dry-run on every channel (also for test sends) |
| NOTIFICATIONS_ALLOW_MOCK | false | Also notify MOCK alerts (demos). The poller then runs in mock mode too |
| ALERT_POLL_MINUTES | 5 | Poll interval |
| NOTIFICATIONS_MAX_ALERT_AGE_MINUTES | 60 | Eligibility window for alerts older than the watermark |
| NOTIFICATIONS_LOG_RETENTION_DAYS | 90 | 0 keeps everything |
| ALERT_SNS_TOPIC_ARN | unset | SNS topic for e-mail |
| SLACK_WEBHOOK_URL | unset | Secret |
| TEAMS_WEBHOOK_URL | unset | Secret |
| TEAMS_WEBHOOK_FORMAT | adaptive | `adaptive` or `messagecard` |
| NOTIFICATIONS_WEBHOOK_HOST_ALLOWLIST | unset | Extra allowed hosts, comma separated (wildcard `*.example.com`) |
| DASHBOARD_BASE_URL | unset | Falls back to FRONTEND_URL |
| INTEGRATION_MODE | mock | Must be `live` for the poller to fetch real alerts |

## Set-up step by step

**Slack**: create a Slack app, enable Incoming Webhooks, add a webhook to the target channel, copy the URL (`https://hooks.slack.com/services/...`) into `SLACK_WEBHOOK_URL`.

**Microsoft Teams**: in the target channel use Workflows ("Post to a channel when a webhook request is received"), copy the generated URL (a `*.logic.azure.com` or `*.environment.api.powerplatform.com` host) into `TEAMS_WEBHOOK_URL`. Legacy Office 365 connector URLs (`*.webhook.office.com`) work with `TEAMS_WEBHOOK_FORMAT=messagecard`.

**E-mail (Google Workspace SMTP)**: set `SMTP_HOST`, `SMTP_PORT` (587, STARTTLS is required), `SMTP_FROM` and `ALERT_EMAIL_TO` (comma separated). Two ways to authenticate:
- `smtp.gmail.com` with `SMTP_USER` and `SMTP_PASSWORD` = an **app password** (the sending account needs 2-Step Verification; `SMTP_FROM` must be that account or one of its aliases). Google limits a Workspace account to about 2,000 messages a day.
- `smtp-relay.gmail.com`: a Workspace admin adds a relay rule (Google Admin > Apps > Google Workspace > Gmail > Routing > SMTP relay service) allowing the backend's outbound IP; `SMTP_USER`/`SMTP_PASSWORD` can stay empty.
`SMTP_PASSWORD` is a secret (env or Secrets Manager only). Press "Check connection" (connect + auth, sends nothing) then "Send test". When `SMTP_HOST` is set, SNS is not used.

**E-mail (SNS)** (used only when `SMTP_HOST` is empty): deploy the topic (see IaC below) or create one with a KMS key the task role may use, set `ALERT_SNS_TOPIC_ARN`, and give the backend task role `sns:Publish` on it. Subscribe the e-mail addresses (CDK context `alertEmails` or the console). **Every SNS e-mail subscriber receives a confirmation e-mail from AWS and must click the link; unconfirmed subscribers receive nothing.**

Then set `NOTIFICATIONS_ENABLED=true`, restart the backend, open the Notifications page, press "Send test" for each channel and review the rules.

### Connecting and testing the e-mail (SNS) channel

1. **In AWS (SNS console, same region as `AWS_REGION`)**: Topics > Create topic > type *Standard*, name e.g. `urbani-radar-alerts`. Copy the topic **ARN**.
2. **Subscribe the recipients**: open the topic > Create subscription > Protocol *Email*, Endpoint = the address. Each recipient gets "AWS Notification - Subscription Confirmation" and must click *Confirm subscription*. Status stays *Pending confirmation* until then, and pending subscribers receive nothing.
3. **Permissions** for whoever runs the backend (ECS task role in AWS, or an IAM user for local runs), on that topic only:
   - `sns:Publish` (send)
   - `sns:GetTopicAttributes` (the read-only "Check connection")
   - if the topic is encrypted with a customer-managed KMS key: `kms:Decrypt` and `kms:GenerateDataKey*` on that key (the CDK construct adds this). Topics without encryption need nothing extra.
4. **Environment** (backend `.env` or ECS task definition):
   ```
   AWS_REGION=us-east-1                      # region of the topic
   ALERT_SNS_TOPIC_ARN=arn:aws:sns:us-east-1:<account-id>:urbani-radar-alerts
   DASHBOARD_BASE_URL=https://<dashboard host>   # optional, adds the link in the e-mail
   NOTIFICATIONS_ENABLED=true                # master switch for automatic sending
   # local runs only (on ECS the task role is used; do not set keys there):
   AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...
   ```
   `INTEGRATION_MODE=live` is also required for the poller to pick up real alerts.
5. **Test in the UI** (Super Admin or Infra Admin): *Notifications > E-mail (Amazon SNS)*:
   - **Check connection** calls `GetTopicAttributes`. It sends nothing and tells you whether the credentials, region and ARN work, and how many subscribers are confirmed or pending. Typical results: "Connected. 2 confirmed subscribers", "Connected, but no subscriber has confirmed yet", or an AWS error with a hint (`sns:GetTopicAttributes` missing, topic not found in this region, no credentials).
   - **Send test** publishes a clearly labelled `[TEST]` message. The recipients should receive it within about a minute (check spam). The result is also in the delivery log below.
   - Start with `NOTIFICATIONS_DRY_RUN=true` if you want to see the flow without any AWS call; the connection check still calls AWS (it is read-only).

API equivalents: `POST /api/notifications/check {"channel":"EMAIL"}` and `POST /api/notifications/test {"channel":"EMAIL"}` (both need `alerts:rules`, share a 5-per-minute limit, and are audited as `notification.test_send`; the check has `check: true` in its metadata).

Dry run first: with `NOTIFICATIONS_DRY_RUN=true` the whole flow runs and the log shows what would have been sent.

## Infrastructure (authored, not deployed)

`infra/lib/notifications-construct.ts`, enabled with `-c enableNotifications=true`: a KMS-encrypted SNS topic `urbani-radar-alerts`, optional e-mail subscriptions (`-c alertEmails=a@x.com,b@y.com`), and `sns:Publish` on that topic plus `kms:Decrypt`/`kms:GenerateDataKey*` via SNS for the dashboard task role. Webhook URLs stay in Secrets Manager: pass existing secret names with `-c slackWebhookSecretName=... -c teamsWebhookSecretName=...` to get their ARNs as stack outputs, then wire them as ECS `secrets` (`SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`) in the task definition (backlog item 14; the task execution role needs `secretsmanager:GetSecretValue`).

## Security notes

- Webhook URLs and the topic ARN are read from the environment only. They never appear in logs, audit events, API responses or the delivery log. The API shows a masked host (for example `***.webhook.office.com`) or the topic name.
- SSRF guard: a webhook must be `https`, have no credentials or custom port, and its host must match the allow-list. Otherwise the channel is `NOT_CONFIGURED` with a reason such as "SLACK_WEBHOOK_URL rejected: host is not on the allow-list". No request is made. Redirects are not followed.
- Error text is stripped of every URL before it is stored or logged.
- Mutating rules/settings and test sends need `alerts:rules` (DRAFT matrix: Super Admin and Infra Admin). Reading needs `alerts:view`. Test sends are rate limited to 5 per minute per user. All mutations and test sends are audited (`notification.rule_create`, `.rule_update`, `.rule_delete`, `.settings_update`, `.test_send`).
- Notifications are advisory. Nothing here remediates anything.

## What we need from the client

1. Alert e-mail addresses (and who confirms the SNS subscriptions).
2. Slack and/or Teams webhook URLs (or confirmation of which tools are used), created by Urbani.
3. The real rules: minimum severity, services, anomaly types, channels per audience, and the dedup window (default 30 min) and hourly cap (default 30).
4. The public dashboard URL for deep links.
5. Confirmation that an in-process notifier is acceptable instead of the proposed Streams + Lambda design.
6. AWS account and region for the SNS topic.
