# Urbani DPI: Google Sign-In and E-mail Alerts
## Configuration and Go-Live Handover

| | |
|---|---|
| Product | Urbani DPI (Proactive Observability and AI Troubleshooting) |
| Environment | Production, `https://dpi.urbani.io` |
| Date | 11 November 2026 |
| Audience | Urbani IT, Security and Operations |
| Status | Ready for staging verification. Production go-live depends on the open items in section 8 |

---

## 1. Summary

Two capabilities were added to the platform:

1. **Single sign-on with Google.** Users sign in with their Google account. A Super Admin controls who may use the platform and which role each person has.
2. **Alert e-mail through Google Workspace.** When an alert matches a notification rule, an e-mail is sent through Gmail SMTP to every active user holding a chosen role.

The break-glass local administrator login stays available, so the platform can never lock itself out.

---

## 2. Google sign-in

### 2.1 How it works
1. The user clicks **Sign in with SSO** and signs in at Google.
2. Google confirms the user's identity and e-mail address. The platform never sees the Google password.
3. The platform looks for a user with that e-mail address on its **Users** page.
4. If the user exists and is active, they sign in with the **role a Super Admin assigned**. If not, access is denied.

There is no self-registration. A Google account that a Super Admin has not added to the platform cannot get in, even if it belongs to your organisation.

### 2.2 Roles
| Role | Intended use |
|---|---|
| Super Admin | Manages users and all settings |
| Infrastructure Administrator | Infrastructure and operations |
| QA Operator | Day-to-day alert handling |
| Reader / Auditor | Read-only access, audit review |

The permission matrix behind these roles is a **draft pending Urbani sign-off**.

### 2.3 Adding and removing users (Super Admin)
1. Open **Users > Add user**.
2. Enter the person's **Google e-mail address exactly as Google reports it**, their name and their role.
3. **Leave the password empty.** The account then signs in with Google only.
4. The person signs in with SSO and receives the role chosen.

To remove access, deactivate the user on the Users page. This takes effect on their **next request**, not at token expiry. Suspending someone in Google does **not** remove their platform account, so leavers must be deactivated in both places.

Safeguards in place: the last active Super Admin cannot be demoted or deactivated, and nobody can change their own role.

### 2.4 Which accounts may sign in
`OIDC_ALLOWED_EMAIL_DOMAIN` limits sign-in to listed e-mail domains (comma separated, exact match). Recommended production value is the Urbani Workspace domain only. Personal `gmail.com` accounts should be allowed only during testing.

### 2.5 Break-glass administrator
A local administrator with a password stays enabled (`AUTH_LOCAL_ENABLED=true`) for emergencies. Recommendations:
- Use an e-mail address that **cannot** be signed in with Google, for example on a non-existent domain. Otherwise someone who can create a matching Google mailbox could take over that account.
- Keep its password in Secrets Manager and rotate it after first use.
- Require MFA for privileged local logins (`MFA_REQUIRED_ROLES=SUPER_ADMIN,INFRA_ADMIN`).

---

## 3. Alert e-mail

### 3.1 How it works
- Alerts are checked on a schedule (every 5 minutes by default) against the notification rules.
- A matching alert is e-mailed through `smtp.gmail.com` from the sender account (`dpiurbani@gmail.com`).
- **Recipients** are all active users whose role is listed in `ALERT_EMAIL_ROLES` (currently Super Admin, QA Operator and Infrastructure Administrator). The list is read from the Users page at send time, so adding a user or changing a role applies to the next alert with no restart. Fixed extra recipients can be added with `ALERT_EMAIL_TO`.
- Addresses on non-deliverable domains (such as `.local` or `.example`) are skipped, and duplicates are removed.
- Failures are retried up to three times. The SMTP password is never written to logs or returned by the API.

### 3.2 Safe rollout
The platform starts in **dry-run mode** (`NOTIFICATIONS_DRY_RUN=true`): messages are written to the delivery log, but nothing is sent. Rollout order:
1. Review the delivery log and confirm the right rules and recipients appear.
2. On **Notifications > E-mail**, click **Check connection**. It signs in to Gmail and sends nothing.
3. Set `NOTIFICATIONS_DRY_RUN=false`, redeploy, then click **Send test** and confirm the mail arrives.

### 3.3 Sender account
- A dedicated Google account with **2-Step Verification** enabled.
- A Google **app password** for this platform, stored only in Secrets Manager.
- Gmail limits: about 500 recipients per day for a personal account and 2,000 for Workspace. Alert volume is far below this.
- To avoid spam filtering, publish SPF, DKIM and DMARC for the sending domain. A Workspace sender on the Urbani domain is stronger than a personal Gmail address for production.

---

## 4. Production configuration

### 4.1 Plain settings
| Setting | Value |
|---|---|
| `AUTH_PROVIDER` | `oidc` |
| `AUTH_LOCAL_ENABLED` | `true` |
| `OIDC_ISSUER` | `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | Google OAuth client id |
| `OIDC_REDIRECT_URI` | `https://dpi.urbani.io/api/auth/sso/callback` |
| `OIDC_ALLOWED_EMAIL_DOMAIN` | Urbani Workspace domain (comma separated for several) |
| `OIDC_AUTO_PROVISION` | `false` |
| `OIDC_EMAIL_ROLE_MAP` | Optional. Only to bootstrap the first Super Admin |
| `MFA_REQUIRED_ROLES` | `SUPER_ADMIN,INFRA_ADMIN` (policy to be confirmed) |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `587` (STARTTLS required) |
| `SMTP_USER` | `dpiurbani@gmail.com` |
| `SMTP_FROM` | `Urbani Radar <dpiurbani@gmail.com>` |
| `ALERT_EMAIL_ROLES` | `SUPER_ADMIN,QA_OPERATOR,INFRA_ADMIN` |
| `ALERT_EMAIL_TO` | Optional fixed recipients |
| `NOTIFICATIONS_ENABLED` | `true` |
| `NOTIFICATIONS_DRY_RUN` | `true` first, then `false` |
| `DASHBOARD_BASE_URL` | `https://dpi.urbani.io` |

### 4.2 Secrets (AWS Secrets Manager, values never shared in documents or chat)
| Secret | Used for |
|---|---|
| `urbaniqa/dpi/oidc-client-secret` | Google OAuth client secret |
| `urbaniqa/dpi/smtp-password` | Gmail app password |
| `urbaniqa/dpi/jwt-secret` | Session signing |
| `urbaniqa/dpi/mfa-encryption-key` | MFA secret encryption |
| `urbaniqa/dpi/seed-admin-password` | Break-glass administrator |
| `urbaniqa/observability/api-key` | Urbani QA API |

The task execution role must be allowed to read each secret. A secret with no value stops the service from starting.

---

## 5. Setup steps for Urbani

### 5.1 Google Cloud (SSO)
1. In Google Cloud Console, create or choose a project.
2. Set the OAuth consent screen to **Internal** (Workspace users only). It must be **External** only if personal Gmail accounts will be allowed, in which case each test address must be listed under Test users until the app is published.
3. Create an OAuth client of type **Web application** with the authorised redirect URI `https://dpi.urbani.io/api/auth/sso/callback`.
4. Store the client secret in Secrets Manager. If a secret was ever shared in e-mail or chat, **rotate it first**.

### 5.2 Google Workspace (e-mail)
1. Create the sender account and turn on 2-Step Verification.
2. Create an app password named `Urbani DPI` and store it in Secrets Manager. If it was ever shared, revoke it and create a new one.
3. Publish SPF, DKIM and DMARC for the sending domain.
4. Allow outbound TCP port 587 to `smtp.gmail.com` from the service's subnet.

### 5.3 In the platform
1. Sign in as the break-glass administrator.
2. Create the first real Super Admin on the Users page, with an empty password.
3. That person signs in with Google and creates the remaining users.

---

## 6. Acceptance checklist

| # | Check | Expected result |
|---|---|---|
| 1 | Login page | A "Sign in with SSO" button is shown |
| 2 | Super Admin signs in with Google | Lands on the dashboard with the Super Admin role |
| 3 | Super Admin creates a user, empty password | Account appears with sign-in method SSO |
| 4 | New user signs in with Google | Receives the role chosen |
| 5 | Google account not on the Users page | Denied with a "no role assigned" message |
| 6 | Account from a domain not in the allowed list | Denied with "domain not allowed" |
| 7 | Deactivated user | Blocked at next sign-in and next request |
| 8 | Break-glass administrator | Still signs in with its password |
| 9 | Notifications > E-mail > Check connection | Connected and authenticated |
| 10 | Dry run | Delivery log shows expected rules and recipients, nothing sent |
| 11 | Dry run off, Send test | Test mail arrives in the inbox (check spam) |
| 12 | Audit page | Shows `auth.sso_login`, `user.create` and `sso.denied` events |

---

## 7. Verification status (honest summary)

| Area | Status |
|---|---|
| Google sign-in on a local environment | **Verified** with a real Google login |
| Role assignment from the Users page, domain rules, deactivation | Covered by automated tests (20 SSO tests passing) |
| Gmail SMTP connection and authentication | **Verified** locally (connection check passed) |
| Delivery of a real alert e-mail | **Pending.** The test needs at least one active user with a real e-mail address and a role in `ALERT_EMAIL_ROLES` |
| Production verification of all items in section 6 | **Pending** |

---

## 8. Open items before go-live

**Platform readiness**
1. **Persistent storage.** The service currently keeps its data in an ephemeral SQLite volume. Without a persistent volume (Amazon EFS) or the DynamoDB option, **every redeploy erases the user list, audit log and preferences**. This must be resolved before real users are added.
2. **Single instance.** While SQLite is used, the service must run exactly one task, so each deployment briefly interrupts service.
3. **Release alignment.** Deploy through one maintained release script so the running configuration matches the documented one. Confirm the latest backend and frontend images are deployed.

**Decisions and inputs needed from Urbani**
| Item | Needed |
|---|---|
| Workspace domain(s) allowed to sign in | Domain list |
| First Super Admin | Google e-mail address |
| Who may create Super Admins, and the leaver process | Policy |
| Alert recipients | Confirm roles in `ALERT_EMAIL_ROLES` and any fixed addresses |
| MFA policy for local privileged logins | Confirm `SUPER_ADMIN,INFRA_ADMIN` |
| Role permission matrix | Sign-off |
| Health check URLs for QA, Main and Payment | URLs, and network reachability from the service |
| Retention periods (audit 365 days, chat 90 days are placeholders) | Confirm or change |
| Sender account type | Personal Gmail or Workspace address on the Urbani domain |
| Rotated Urbani QA API key | Confirm rotation is done |

**Data sources.** Logs, alerts and the AI assistant are live from the Urbani AWS backend. Metrics, service health details and usage and cost remain **sample data** until Urbani provides the matching AWS endpoints. The platform labels the data source on each panel.

---

## 9. Security notes
- Authentication is delegated to Google. The platform stores no password for SSO users.
- Access requires **both** a verified Google identity in an allowed domain **and** a platform user created by a Super Admin.
- Anyone who can create or alias a mailbox in an allowed domain can claim a platform user with that e-mail address. Treat Workspace administration as part of the platform's security.
- SSO users get multi-factor protection from Google. Enforce 2-Step Verification across the Workspace domain.
- Secrets live only in Secrets Manager. Rotate any secret that has been shared outside it.
- Sign-ins, denials, user changes and role changes are written to the audit log.

---

## 10. Rollback
- Turn SSO off by setting `AUTH_PROVIDER=local` and redeploying. Local logins are unaffected.
- Turn e-mail off by clearing `SMTP_HOST` or setting `NOTIFICATIONS_ENABLED=false`.
- Neither change touches stored data.

---

## 11. Contacts
| Role | Name | Contact |
|---|---|---|
| Platform owner (Urbani) | | |
| Delivery lead | | |
| Google Workspace administrator | | |
| AWS administrator | | |
