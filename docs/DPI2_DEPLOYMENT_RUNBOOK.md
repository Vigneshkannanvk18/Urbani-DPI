# DPI 2 deployment runbook (parallel service)

Status: **authored and validated locally. Nothing in this runbook has been executed against AWS.** The scripts are therefore unproven against a real account; expect small adjustments on the first real run (see "First things to check").

DPI 2 is deployed as a **second ECS service next to DPI 1**. DPI 1 (`urbaniqa-dpi-svc`, `dpi.urbani.io`, listener priority 400) is never modified. Rollback is "stop sending traffic to DPI 2". The go-live matrix with everything we still need from the client is in [DPI2_GO_LIVE_MATRIX.md](DPI2_GO_LIVE_MATRIX.md); the plan to merge `dpi2` into `main` is in [DPI2_INTEGRATION_PLAN.md](DPI2_INTEGRATION_PLAN.md).

| What | DPI 1 (live) | DPI 2 (parallel) |
|---|---|---|
| Scripts | `deploy-ecs.sh`, `redeploy.sh` | `deploy-ecs-dpi2.sh`, `redeploy-dpi2.sh` (+ `deploy/lib.sh`) |
| Service / task family | `urbaniqa-dpi-svc` / `urbaniqa-dpi-task` | `urbaniqa-dpi2-svc` / `urbaniqa-dpi2-task` |
| Host / ALB rule | `dpi.urbani.io`, priority 400 | `dpi2.urbani.io`, priority 401 |
| Storage | SQLite on a task-local volume (lost on replacement) | DynamoDB `UrbaniApp` (PITR, CMK, deletion protection) |
| Tasks | 1 | 2 across two AZs, Auto Scaling 2 to 6 |
| ECR | `urbaniqa/dpi-backend`, `urbaniqa/dpi-frontend` | `urbaniqa/dpi2-backend`, `urbaniqa/dpi2-frontend` |
| Log group | `/urbani/dpi` | `/urbani/dpi2` |

## 1. Safety model of the scripts

- **Dry-run is the default.** Without `APPLY=1` the scripts print every step and the exact command or JSON, and make **zero** `aws` calls (and no docker or openssl calls).
- **Apply needs a typed confirmation:** `APPLY=1 CONFIRM_ACCOUNT=<ACCOUNT_ID>`. The script then checks `sts get-caller-identity` matches.
- The scripts refuse DPI 1's names (service, task family, target group, log group, roles, ECR repos, priority 400, `dpi.urbani.io`) unless `CUTOVER=1`.
- Images are tagged with the git short SHA and `latest`; the task definition only ever uses the SHA tag. A dirty working tree is refused in apply mode (`ALLOW_DIRTY=1` overrides).
- Secrets are generated with `openssl` and piped straight into Secrets Manager. No secret value is printed or written to disk. Only ARNs and names appear in output and in the generated JSON.
- Everything is idempotent (create-if-missing). Run subsets with `STEPS=a,b` and skip with `SKIP=a`.
- Run on Linux, macOS, CloudShell or WSL with: bash, AWS CLI v2, docker (buildx), node 18+, openssl, git.

## 2. Prerequisites checklist (mapped to client inputs)

| # | Prerequisite | Who | Needed for |
|---|---|---|---|
| 1 | Approval to deploy DPI 2 as a parallel service in account 701179923456 (us-east-1) | Client | everything |
| 2 | Operator credentials with rights to create ECR, IAM roles, DynamoDB, KMS, Secrets Manager, ECS, ELBv2, Application Auto Scaling, CloudWatch Logs (SNS, Route 53 optional) | Client / AWS team | everything |
| 3 | Confirm the existing VPC, two private subnets, task security group, ALB and listener ARNs in `deploy/dpi2.env` still match (they are DPI 1's values) | AWS team | tg, listener, service |
| 4 | Hostname for the parallel service (default `dpi2.urbani.io`) and approval to create the DNS record (the ACM wildcard `*.urbani.io` already covers it) | Client | listener, dns |
| 5 | **Rotated Urbani API key** (the shared key was exposed in DPI 1; see integration plan) | Urbani | `SECRET_NAME_URBANI_API_KEY` |
| 6 | DynamoDB table prefix decision (default `Urbani`, table `UrbaniApp`) | Client | dynamodb |
| 7 | Alert e-mail addresses (item 6), Slack and Teams webhook URLs | Client | notifications |
| 8 | Google Workspace admin access, group-to-role map, callback URL (item 5 SSO) | Client | Cognito / OIDC |
| 9 | Log group names and read access for QA, Main, Payment (item 4) | Client | `LOGS_SOURCE=insights` |
| 10 | Health endpoint URLs for QA, Main, Payment (item 9) | Client | `HEALTH_TARGETS` |
| 11 | Retention periods (audit, chat), PII policy, MFA policy, permission matrix sign-off, widget scope, SLOs | Client | policy settings |
| 12 | Official logo and palette | Client | branding |

Items 1 to 6 are required for the first deployment. Items 7 to 12 switch features on later without a redeploy of infrastructure (a new task definition revision).

## 3. First parallel deployment (ordered steps)

1. **Prepare config.** `cp deploy/dpi2.env.example deploy/dpi2.env`; fill the REQUIRED values (see the comments). `deploy/dpi2.env` is gitignored and holds no secret values.
2. **Validate locally.** `npm run check:deploy` (cross-checks the config against the backend schema and renders the task definition) and `npm test`.
3. **Dry-run.** `./deploy-ecs-dpi2.sh` and read the plan. Optional: `./redeploy-dpi2.sh --only backend`.
4. **Create the foundations** (no traffic yet): `APPLY=1 CONFIRM_ACCOUNT=701179923456 STEPS=ecr,logs,kms,dynamodb,secrets,sns,iam ./deploy-ecs-dpi2.sh`.
5. **Put the rotated Urbani API key.** The script created an empty secret. Write the key into a local file with your editor (not on the command line, not in shell history), then:
   `aws secretsmanager put-secret-value --secret-id urbaniqa/dpi2/urbani-api-key --secret-string file://urbani-api-key.txt` and delete the file.
6. **Build, register, bootstrap, serve:** `APPLY=1 CONFIRM_ACCOUNT=701179923456 STEPS=images,taskdef,bootstrap,tg,listener,service,autoscaling ./deploy-ecs-dpi2.sh`. The bootstrap step runs a one-off task with the backend image: `node packages/backend/dist/db/seed.js --allow-aws` with `FORCE_DB_SEED=yes`. It seeds the first Super Admin (`SEED_ADMIN_EMAIL`, password from Secrets Manager) and the reference rows. It also loads the standard demo rows, all stored with `data_source = MOCK` and labelled MOCK in the UI; LIVE data then overlays them. The step is skipped if the table already has data (`FORCE_BOOTSTRAP=1` to override).
   - The table itself is created by the `dynamodb` step. The `cli.js tables` command deliberately refuses AWS endpoints, so it is only used with DynamoDB Local.
7. **DNS (needs approval).** `APPLY=1 CONFIRM_ACCOUNT=... CONFIRM_DNS=dpi2.urbani.io STEPS=dns ./deploy-ecs-dpi2.sh`, or create the record in the console.
8. **Get the admin password** (operator terminal only): `aws secretsmanager get-secret-value --secret-id urbaniqa/dpi2/seed-admin-password --query SecretString --output text`. Log in, enrol MFA, create the named users, then change the password. Treat the secret as a one-time bootstrap credential.
9. **Verify** with the checklist below.

Optional: `ENABLE_CONTAINER_INSIGHTS=1` (cluster-wide, shared with DPI 1, adds cost) and `ENABLE_EXEC=1` (ECS Exec; adds SSM permissions to the task role). Both are off by default.

## 4. Verification checklist after deploy

- [ ] ECS service stable with 2 running tasks in 2 different AZs; Auto Scaling target registered (min 2, max 6).
- [ ] ALB target group: 2 healthy targets (`/healthz`).
- [ ] `https://dpi2.urbani.io/healthz` is `ok`; `/api/health` is 200 (liveness); `/api/ready` is 200 (DynamoDB reachable).
- [ ] Login as the seeded admin works; a wrong password gives 401. Wait for logs to show `Persistence driver: dynamodb`.
- [ ] MFA: enrol TOTP for the admin, log out and in with a code; recovery codes shown once.
- [ ] RBAC: create one user per role; Reader/Auditor cannot acknowledge alerts or open Users; QA Operator limits as per the (draft) matrix.
- [ ] Logs page: filters, regex, pagination return data (MOCK or LIVE as labelled).
- [ ] Audit page shows the login and the user creation events.
- [ ] Exports: CSV, JSON, PDF of logs/alerts and the incident report download.
- [ ] Notifications: with `NOTIFICATIONS_DRY_RUN=true` first, then "Send test" per channel.
- [ ] Health panel shows QA/Main/Payment as LIVE or WAITING_FOR_INTEGRATION as configured.
- [ ] Chat: ask a question; live answer, latency shown, like/dislike stored, history lists the session.
- [ ] Dashboard personalization (drag, reset) persists after reload; dark mode persists.
- [ ] Stop one task (`aws ecs stop-task`): service replaces it, no user-visible 502 and sessions continue (state is in DynamoDB).
- [ ] CloudWatch log group `/urbani/dpi2` has `backend` and `frontend` streams and no repeated errors.

## 5. Turning on each integration (flip env vars, then redeploy the task definition)

Change the value in `deploy/dpi2.env`, then `STEPS=iam,taskdef,service ./deploy-ecs-dpi2.sh` (with APPLY and CONFIRM). `redeploy-dpi2.sh` keeps the current environment and only changes images, so it is not used for config changes.

| Integration | Do this |
|---|---|
| E-mail alerts (item 6) | `ENABLE_SNS=1`, `ALERT_EMAILS=a@x,b@x`, `NOTIFICATIONS_ENABLED=true`, `DASHBOARD_BASE_URL`; run the `sns` and `iam` steps; every recipient must click the SNS confirmation e-mail. Start with `NOTIFICATIONS_DRY_RUN=true`. |
| E-mail alerts through Google Workspace SMTP (item 6, replaces SNS) | Create the sender account and an app password (docs/NOTIFICATIONS.md). Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_FROM`, `ALERT_EMAIL_TO`, `DASHBOARD_BASE_URL`. Run the `secrets` step (creates the empty `urbaniqa/dpi2/smtp-password` shell), then `aws secretsmanager put-secret-value --secret-id urbaniqa/dpi2/smtp-password --secret-string file://pw.txt`, add `SMTP_PASSWORD` to `ENABLED_OPTIONAL_SECRETS`, run `iam` (the execution role gets read access to that secret only) and redeploy. The task needs outbound TCP 587 to `smtp.gmail.com` (public IP or NAT). Start with `NOTIFICATIONS_DRY_RUN=true`, then use "Check connection" and "Send test". Set up SPF, DKIM and DMARC on the sender domain. |
| Slack / Teams | `aws secretsmanager put-secret-value --secret-id urbaniqa/dpi2/slack-webhook-url --secret-string file://hook.txt`; set `ENABLED_OPTIONAL_SECRETS=SLACK_WEBHOOK_URL[,TEAMS_WEBHOOK_URL]`; `NOTIFICATIONS_ENABLED=true`. Use "Send test". Never enable a secret that has no value: the task cannot start. |
| Log search on CloudWatch (item 4) | `LOGS_SOURCE=insights`, `LOGS_INSIGHTS_LOG_GROUPS=main=/aws/ecs/urbaniqa-qa-main/app,payments=...`; run `iam` (adds `logs:StartQuery` on those groups only). The groups may live in the same account and region. |
| MFA policy (item 5) | `MFA_REQUIRED_ROLES=SUPER_ADMIN,INFRA_ADMIN` (client decision). The encryption key is already generated. |
| SSO with Google directly (item 5, no Cognito) | In Google Cloud Console create an OAuth client (Web application, consent screen Internal) with redirect URI `https://<host>/api/auth/sso/callback`. Set `AUTH_PROVIDER=oidc`, `OIDC_ISSUER=https://accounts.google.com`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_ALLOWED_EMAIL_DOMAIN`, and for the first Super Admin `OIDC_EMAIL_ROLE_MAP='{"admin@urbani.io":"SUPER_ADMIN"}'`. `put-secret-value` the client secret into `urbaniqa/dpi2/oidc-client-secret`, add `OIDC_CLIENT_SECRET` to `ENABLED_OPTIONAL_SECRETS`, run `iam`, redeploy. Further users are created by that Super Admin on the Users page (leave the password empty). Keep `AUTH_LOCAL_ENABLED=true`. Full guide: docs/AUTH_MFA_SSO.md section 2b. |
| SSO through Cognito (item 5) | Create the Cognito pool with the CDK construct (`-c enableCognito=true ...`, separate approval), then set `AUTH_PROVIDER=oidc`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_GROUP_ROLE_MAP`, put `oidc-client-secret`, `ENABLED_OPTIONAL_SECRETS=OIDC_CLIENT_SECRET`. Keep `AUTH_LOCAL_ENABLED=true` as break-glass. Test with a real Google login first. |
| Health targets (item 9) | `HEALTH_TARGETS='[{"id":"qa","type":"http","url":"https://..."}]'` (single line, single quotes); `HEALTH_ALLOW_PRIVATE_TARGETS=true` only for internal addresses. |
| Retention (items 3, 8, 9) | `AUDIT_RETENTION_DAYS`, `CHAT_RETENTION_DAYS`, `HEALTH_RETENTION_DAYS`, `NOTIFICATIONS_LOG_RETENTION_DAYS`. |
| Synthetics + Route 53 health checks (item 9) | CDK `health-monitoring-construct` with `enableHealthMonitoring` and `healthEndpoints` (separate approval; not part of these scripts). |

## 6. Monitoring

- Log group `/urbani/dpi2` (30 days). Streams: `backend/...`, `frontend/...`, `bootstrap/...`.
- Alarms to create (not created by the scripts, to keep the shared account footprint small): ALB `HTTPCode_Target_5XX_Count` and `UnHealthyHostCount` for the DPI 2 target group; ECS service `CPUUtilization` and `MemoryUtilization` above 85% for 10 minutes; DynamoDB `ThrottledRequests` and `SystemErrors` on `UrbaniApp`; ECS `RunningTaskCount` below 2. Send them to the SNS topic when `ENABLE_SNS=1`.
- The ALB idle timeout (60 s default) is below the backend keep-alive (65 s, fixed in item 13) and nginx `proxy_read_timeout` is 65 s, so intermittent 502 from stale connections should not recur.
- Container Insights is off by default (cluster-wide, shared).

## 7. Rollback

- **Bad deployment:** the service has a deployment circuit breaker with rollback. Manual rollback: the `redeploy-dpi2.sh` output ends with the exact `aws ecs update-service --task-definition <previous>` command.
- **Bad release, DPI 2 not yet cut over:** nothing to do for users; they are on DPI 1.
- **After cutover:** swap the host conditions back (section 8) so `dpi.urbani.io` goes to DPI 1's target group again. DPI 1 stays running until decommissioning.
- Data: DPI 2 writes only to DynamoDB; DPI 1's SQLite is untouched. Switching users back to DPI 1 loses nothing in DPI 1 but DPI 2-only data (new users, audit events) stays in DynamoDB.

## 8. Cutover to dpi.urbani.io (after client approval)

Both listener rules are host-header rules on the same ALB. The lower priority number wins, so swap hosts instead of deleting anything:

1. Confirm DPI 2 has been verified (section 4) for an agreed period and DPI 1 data decisions are made (section 10).
2. Move DPI 1 to a temporary host: `aws elbv2 modify-rule --rule-arn <rule 400 arn> --conditions Field=host-header,Values=dpi1.urbani.io` (and create the DNS record for it if you want to keep reaching it).
3. Point `dpi.urbani.io` at DPI 2: `aws elbv2 modify-rule --rule-arn <rule 401 arn> --conditions Field=host-header,Values=dpi.urbani.io`. The existing Route 53 alias for `dpi.urbani.io` already targets the same ALB, so no DNS change is needed.
4. Set `DASHBOARD_BASE_URL=https://dpi.urbani.io` (and `OIDC_REDIRECT_URI` if SSO is on) and run the `taskdef,service` steps.
5. **Rollback** is the same two commands in reverse.

Do the same edits through the scripts only with `CUTOVER=1` and a reviewed `deploy/dpi2.env` (`DOMAIN=dpi.urbani.io`, `LISTENER_PRIORITY` unchanged). Prefer the two `modify-rule` commands: they are smaller and reversible.

## 9. Decommissioning DPI 1 (only after the agreed observation period)

1. Export or archive the DPI 1 SQLite file if anyone wants the history (section 10).
2. Scale `urbaniqa-dpi-svc` to 0, wait a week, then delete the service, target group, rule, task definitions, and the old ECR repos and roles (`urbaniqa-dpi-exec-role`, `urbaniqa-dpi-task-role`), the `urbaniqa/dpi/jwt-secret` secret, and the old API key secret once rotated.
3. Remove `deploy-ecs.sh` and `redeploy.sh` from `main` in a separate commit.

## 10. Data migration choices

- **Recommended: fresh DynamoDB and re-sync.** DPI 1's data is task-local (lost whenever the task is replaced) and mostly re-derivable: LIVE logs and alerts re-sync from the Urbani API on the next refresh. What is lost: acknowledgements, DPI 1 audit and AI-analysis history, DPI 1 user accounts (a handful). The bootstrap step creates the admin; create named users in the Users page.
- **Optional: copy SQLite into DynamoDB** with the item 1 migration CLI. Take the DPI 1 file before any DPI 2 image ever starts on it (migration 002 is forward-only): enable ECS Exec on a DPI 1 task, checkpoint the WAL (`node -e "const D=require('better-sqlite3');const d=new D('/data/urbani.sqlite');d.pragma('wal_checkpoint(TRUNCATE)');d.close()"`), copy the file out, then from a dpi2 build on an operator host: `npm run dynamo:migrate -- --source <abs path to the copy> --dry-run --allow-aws`, check the printed source line, then run without `--dry-run`. Idempotent; run it before the bootstrap seed. Users imported this way keep their password hashes.
- Either way DPI 1 users must be told their DPI 2 password; the seeded admin password lives in Secrets Manager.

## First things to check on the first real run

1. IAM propagation: the `iam` step waits 10 s; if `register-task-definition` or the first task complains about the role, re-run `taskdef,service`.
2. `file:///dev/stdin` for `--secret-string` (Linux/macOS/CloudShell); it does not work on native Windows CLI.
3. Task cannot start with `ResourceInitializationError` for a secret: the secret has no value, or the execution role policy resource does not match (the policy uses the name plus `-??????`).
4. Subnets must reach ECR, Secrets Manager, DynamoDB, CloudWatch (NAT or VPC endpoints), as DPI 1 does.
5. The task security group must allow ALB to 8080, and egress to the Urbani API Gateway and DynamoDB.
6. Target group `ResourceLabel` for the request-count scaling policy is derived from the ALB and target group ARNs; check the policy was accepted.
7. A KMS key policy that is not the default (account-root) policy may need the task role added.
8. The node 20 runtime prints an AWS SDK support notice (SDK v3 will require node 22 after January 2027); plan to move the base images to node 22.

## Go-live checklist: Google SSO and Google Workspace e-mail

Run in staging first (same steps, staging host), then production. Neither feature has been exercised against real Google yet.

**Google side**
1. Sender account created, 2-Step Verification on, app password created (or SMTP relay rule added by a Workspace admin).
2. SPF, DKIM and DMARC published for the sender domain.
3. OAuth client created (Web application, consent screen Internal) with the exact redirect URI `https://<host>/api/auth/sso/callback`.
4. 2-Step Verification enforced for the Workspace domain (SSO users skip the app's own TOTP).

**AWS side**
5. `deploy/dpi2.env`: `SMTP_*`, `ALERT_EMAIL_TO`, `AUTH_PROVIDER=oidc`, `OIDC_ISSUER=https://accounts.google.com`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_ALLOWED_EMAIL_DOMAIN`, `OIDC_EMAIL_ROLE_MAP` (first Super Admin only), `AUTH_LOCAL_ENABLED=true`, `NOTIFICATIONS_DRY_RUN=true`.
6. `deploy-ecs-dpi2.sh` `secrets` step, then `put-secret-value` for `smtp-password` and `oidc-client-secret`. Only then set `ENABLED_OPTIONAL_SECRETS=SMTP_PASSWORD,OIDC_CLIENT_SECRET` (a secret with no value stops the task from starting).
7. `npm run check:deploy`, then the `iam` step, then deploy. Outbound TCP 587 to `smtp.gmail.com` must be allowed from the task.

**Verify (in this order)**
8. Notifications > E-mail > "Check connection" reports connected. "Send test" arrives (check spam).
9. Dry run: with a live alert, the delivery log shows `DRY_RUN` rows for the right rules and recipients. Then set `NOTIFICATIONS_DRY_RUN=false` and `NOTIFICATIONS_ENABLED=true`.
10. Login page shows "Sign in with SSO". The Super Admin in `OIDC_EMAIL_ROLE_MAP` signs in with Google and lands as Super Admin.
11. On Users > Add user create a second user with the password left empty. That user signs in with Google and gets the chosen role.
12. A Google account that is not in the platform is denied. A deactivated user is blocked. An account from another domain is rejected.
13. The break-glass local admin can still sign in with a password.
14. Audit page shows `auth.sso_login`, `user.create` and `sso.denied` entries.

**Rollback**: set `SMTP_HOST` empty to fall back to SNS, and `AUTH_PROVIDER=local` to turn SSO off, then redeploy. Local logins are unaffected.
