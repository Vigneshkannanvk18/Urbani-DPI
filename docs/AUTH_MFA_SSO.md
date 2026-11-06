# Authentication: MFA (TOTP) and SSO (OIDC) - DPI 2, item 5

> **Status.** TOTP MFA is complete and works with nothing from the client. SSO (OIDC) is built and unit-tested against a local fake identity provider only. It has **not** been exercised against real Amazon Cognito or Google Workspace. Defaults (`AUTH_PROVIDER=local`, MFA optional) are placeholders pending client decisions (see the end of this page).

## 1. Flows

### Local login, no MFA (unchanged)
`POST /api/auth/login {email, password}` returns `{ token, user }`.

### Local login with MFA
1. `POST /api/auth/login` with the correct password for an MFA-enabled user returns `{ mfaRequired: true, mfaToken }`. There is **no session token**. `mfaToken` is a JWT with `purpose: "mfa"` that expires after 5 minutes and is accepted only by `POST /api/auth/mfa/verify`; every other route answers 401.
2. `POST /api/auth/mfa/verify {mfaToken, code}` (or `recoveryCode` instead of `code`) returns the normal `{ token, user }`.
3. A wrong code answers a generic `401 Invalid verification code`. After 5 failures the user is locked for 15 minutes (`429 MFA_LOCKED`, audited `mfa.locked`). The endpoint is also rate limited to 10 requests per minute per IP.
4. Replay protection: each 30 s TOTP time-step is accepted once per user. Recovery codes are single use.

### Enrolment (authenticated)
| Endpoint | Purpose |
|---|---|
| `GET /api/auth/mfa/status` | `{enabled, enrolledAt, recoveryCodesRemaining, required, authSource}` |
| `POST /api/auth/mfa/enroll/start` | Creates a **pending** secret. Returns `{secret, otpauthUri, qrDataUrl}` (issuer `Urbani Radar`, account = email). |
| `POST /api/auth/mfa/enroll/confirm {code}` | Activates MFA only after a valid code, then returns 10 one-time `recoveryCodes` (shown once). |
| `POST /api/auth/mfa/disable {password, code\|recoveryCode}` | Needs the current password **and** a valid code. Refused for roles in `MFA_REQUIRED_ROLES`. |
| `POST /api/auth/mfa/recovery-codes/regenerate {password, code\|recoveryCode}` | Replaces all recovery codes. |
| `POST /api/users/:id/mfa/reset` | Super Admin only (`users:manage`). Clears MFA so a locked-out user can enrol again. Audited `mfa.reset`. |

### Policy: required roles
With `MFA_REQUIRED_ROLES=INFRA_ADMIN,SUPER_ADMIN` a user of those roles without MFA gets, after a correct password, `{ mfaEnrollmentRequired: true, enrollToken, user }`. The `enrollToken` (`purpose: "mfa_enroll"`, 15 minutes) works **only** on the three enrolment endpoints above (`status`, `enroll/start`, `enroll/confirm`). `enroll/confirm` then returns the recovery codes and a full `session`. The UI shows a forced-enrolment screen. The policy is checked at login; an already-issued session is not revoked when the policy changes.

### SSO (OIDC, Authorization Code + PKCE)
1. `GET /api/auth/config` (public) returns `{provider, ssoEnabled, localEnabled, ssoLoginUrl}`. The login page shows "Sign in with SSO" only when `ssoEnabled`, and hides the password form when `localEnabled` is false. `localEnabled` is always true while SSO is not usable, so nobody is locked out by a half-finished configuration.
2. `GET /api/auth/sso/login` stores `state`, `nonce` and the PKCE verifier in a signed, HttpOnly, SameSite=Lax cookie (10 minutes, scoped to `/api/auth/sso`) and redirects to the provider.
3. `GET /api/auth/sso/callback` checks the state cookie, exchanges the code (client secret via HTTP Basic if configured), then validates the ID token: RS256 signature against the provider JWKS, issuer, audience, expiry (60 s skew) and nonce.
4. It requires `email_verified`, the optional `OIDC_ALLOWED_EMAIL_DOMAIN`, and at least one group that maps to a role. With several mapped groups the **highest-privilege** role wins (Super Admin > Infra Admin > QA Operator > Reader/Auditor).
5. The user is auto-provisioned (`OIDC_AUTO_PROVISION`, no local password, `auth_source=sso`) or updated. The role is re-synced from the IdP on every SSO login. A **deactivated** user record blocks SSO.
6. Our normal session JWT is issued and the browser is redirected to `/sso-callback#token=...`. The SPA stores the token exactly like a local login and clears the fragment. Denials return a 4xx page (or JSON when `Accept: application/json`) and are audited as `sso.denied`.

SSO users are **exempt from local TOTP**: the identity provider must enforce MFA (see section 4).

## 2. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MFA_REQUIRED_ROLES` | empty | Roles that must use MFA. Empty = optional for all. Placeholder pending client decision. |
| `MFA_ENCRYPTION_KEY` | none | 32 bytes, base64. Encrypts TOTP secrets (AES-256-GCM). **Required in production** to enrol; without it enrolment fails. Dev/test derive a clearly labelled dev key. |
| `AUTH_PROVIDER` | `local` | `local` or `oidc`. |
| `AUTH_LOCAL_ENABLED` | `true` | Keep the password form next to SSO (break-glass admin). Only takes effect when SSO is usable. |
| `OIDC_ISSUER` | none | Issuer URL (`https://cognito-idp.<region>.amazonaws.com/<poolId>`). Must be https in production. |
| `OIDC_CLIENT_ID` | none | App client id. |
| `OIDC_CLIENT_SECRET` | none | App client secret. **Secret**: env or Secrets Manager only. |
| `OIDC_REDIRECT_URI` | none | Must equal `https://<host>/api/auth/sso/callback` and the Cognito callback URL. |
| `OIDC_SCOPES` | `openid email profile` | Requested scopes. |
| `OIDC_GROUPS_CLAIM` | `cognito:groups` | Claim holding the user's groups (array or string). |
| `OIDC_GROUP_ROLE_MAP` | empty | JSON, IdP group to RBAC role. No mapped group = denied. |
| `OIDC_ALLOWED_EMAIL_DOMAIN` | none | Only this email domain may sign in (for example `urbani.io`). |
| `OIDC_AUTO_PROVISION` | `true` | Create a user on first SSO login. |
| `OIDC_POST_LOGIN_URL` | `/` | Reserved landing path setting. |

Role mapping example (the groups created by the CDK construct):

```json
{"SuperAdmins":"SUPER_ADMIN","InfraAdmins":"INFRA_ADMIN","QaOperators":"QA_OPERATOR","ReadersAuditors":"READER_AUDITOR"}
```

## 3. Switching to Cognito + Google (when the client provides access)
1. Deploy the Cognito construct (`infra/lib/cognito-construct.ts`) with context, for example `-c enableCognito=true -c cognitoCallbackUrls=https://<host>/api/auth/sso/callback -c cognitoDomainPrefix=<unique> -c cognitoGoogleSecretArn=<arn>`. It is **off by default** and has never been deployed.
2. For Google: create an OAuth client in the Google Workspace admin console, store `{"client_id": "...", "client_secret": "..."}` in Secrets Manager and pass the ARN. Add the Cognito `https://<domain>.auth.<region>.amazoncognito.com/oauth2/idpresponse` redirect URI on the Google side.
3. Google does not send groups. Add each user to a Cognito group (console, API, or a post-confirmation trigger) so the `cognito:groups` claim is present.
4. Set `AUTH_PROVIDER=oidc`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_GROUP_ROLE_MAP` (and `OIDC_ALLOWED_EMAIL_DOMAIN`) as task environment; put `OIDC_CLIENT_SECRET` and `MFA_ENCRYPTION_KEY` in Secrets Manager. Keep `AUTH_LOCAL_ENABLED=true` until SSO is proven, then decide.
5. Keep a **break-glass local admin** whose email is not in the IdP. An SSO login for an email that already has a local user converts that record to an SSO user (role from the IdP, local password login disabled).

## 4. Security notes
- TOTP secrets are encrypted at rest with AES-256-GCM (`MFA_ENCRYPTION_KEY`); recovery codes are stored as SHA-256 hashes only and are single use. Secrets, codes and tokens are never logged or audited (the audit redaction helper masks keys such as `totp`, `recovery`, `token`, `verifier`).
- Rotating `MFA_ENCRYPTION_KEY` invalidates existing enrolments (users re-enrol after a Super Admin reset). There is no key-versioned re-encryption yet.
- **Cognito and Google must enforce MFA for SSO users.** The app does not ask SSO users for a second factor. Cognito pool MFA (TOTP required) only covers native Cognito users; Google-federated users rely on Google Workspace 2-step verification being enforced for the domain.
- The ID token never reaches the browser. The session token travels in the URL fragment (not sent to servers or logs) and is removed from the address bar immediately.
- The per-IP rate limit is in memory (single instance). With two or more ECS tasks it is per task; the per-user lockout is stored in the database and is shared.
- Audit actions (registered in the shared action catalog): `mfa.enroll`, `mfa.verify_success`, `mfa.verify_failed`, `mfa.recovery_used`, `mfa.recovery_regenerate`, `mfa.disable`, `mfa.reset`, `mfa.locked`, `auth.sso_login`, `sso.denied`, `user.provisioned`.
- Storage: SQLite migration `003_dpi2_mfa_sso.sql` and matching DynamoDB attributes on the user item. The SQLite-to-DynamoDB copy script does not carry MFA state; users re-enrol after a migration.

## 5. Client inputs needed
1. Google Workspace admin access (to create the OAuth client) and the Cognito/AWS account details.
2. The Google group (or user list) to RBAC role mapping, and who administers membership.
3. Decision: SSO, TOTP only, or both, and whether local login stays enabled.
4. The `MFA_REQUIRED_ROLES` policy (default is optional for everyone).
5. Cognito hosted-UI domain prefix and the production callback URL(s).
6. Secrets Manager entries for `MFA_ENCRYPTION_KEY` and `OIDC_CLIENT_SECRET` (and the Google client secret).
