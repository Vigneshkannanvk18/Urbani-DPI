# Item 5 report: MFA (TOTP) + pluggable SSO (OIDC)

Status: DONE (integration pending). Branch `dpi2`, worktree `c:\Antigravity\Urbani DPI\.worktrees\dpi2`, commit `52279c5` (on top of `21bb34e`). Not pushed. LEAN mode.

## What was built

### Part A: TOTP MFA (works with nothing from the client)
- Storage: migration `003_dpi2_mfa_sso.sql` (auth_source, mfa_enabled, mfa_secret_encrypted, mfa_enrolled_at, mfa_recovery_hashes, mfa_last_step, mfa_failed_count, mfa_locked_until). New repository methods `getSecurity`, `listSecurity`, `updateSecurity`, `claimTotpStep` (atomic replay guard), `consumeRecoveryHash` (atomic one-time use) on SQLite and DynamoDB. `UserRow` is unchanged (MFA state is a separate `UserSecurity`); the DynamoDB `upsertUser` carries the security attributes over so a role change cannot wipe MFA.
- Crypto (`lib/totp.ts`, Node crypto only, no OTP library): RFC 6238/4226 TOTP (SHA-1, 6 digits, 30 s, +-1 window), base32, AES-256-GCM envelope for the secret (`MFA_ENCRYPTION_KEY`; labelled dev key outside production; production refuses to enrol without it), 10 recovery codes stored as SHA-256 hashes. QR is generated server-side with `qrcode@1.5.4` (pinned, `@types/qrcode@1.5.5`).
- Login flow: password OK + MFA enabled returns `{mfaRequired, mfaToken}` (5 min, `purpose: mfa`, rejected by every other route, including `requireAuth`). `POST /api/auth/mfa/verify` issues the normal session. Wrong code: generic 401. 5 failures: 15 min lock (429 `MFA_LOCKED`), per-IP limit 10/min via the existing `rateLimit`. TOTP step replay blocked. Recovery codes single use.
- Policy: `MFA_REQUIRED_ROLES` (default empty = optional, placeholder). Required and not enrolled: `{mfaEnrollmentRequired, enrollToken}`; the token works only on `mfa/status`, `enroll/start`, `enroll/confirm`; confirm returns recovery codes plus a full session. Required roles cannot disable MFA.
- Endpoints: `GET mfa/status`, `POST mfa/enroll/start|confirm`, `mfa/disable` and `mfa/recovery-codes/regenerate` (password + code), `POST /api/users/:id/mfa/reset` (Super Admin only, audited). Audit actions registered in the shared catalog: `mfa.enroll`, `mfa.verify_success`, `mfa.verify_failed`, `mfa.disable`, `mfa.recovery_used`, `mfa.recovery_regenerate`, `mfa.reset`, `mfa.locked`. Redaction extended (`totp`, `recovery`, `passcode`, `verifier`).
- UI: Login second step (code input, recovery-code toggle), forced-enrolment screen, Account security page `/security` (status, enrol with QR + manual key, confirm, recovery codes once with copy/download, disable, regenerate), Users page gets an MFA column and a Reset MFA action.

### Part B: SSO via OIDC (behind config)
- Config (`config/authConfig.ts`, read at call time): `AUTH_PROVIDER` (default `local`), `AUTH_LOCAL_ENABLED`, `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI/SCOPES/GROUPS_CLAIM/GROUP_ROLE_MAP/ALLOWED_EMAIL_DOMAIN/AUTO_PROVISION`.
- Flow (`services/ssoService.ts`, in-repo, Node crypto + fetch, no OIDC library): discovery, Authorization Code + PKCE (S256), state+nonce+verifier in a signed HttpOnly cookie, token exchange (Basic client auth), ID-token validation (RS256 via JWKS with rotation refetch, issuer, audience, expiry, nonce), verified email, allowed domain, group to role map with the highest privilege winning, deny with 403 and `sso.denied` when no group maps, auto-provision or update (`auth_source=sso`, no local password), role re-sync on each login, deactivated local record blocks SSO. Then our normal session JWT; redirect to `/sso-callback#token=...`. Audit: `auth.sso_login`, `sso.denied`, `user.provisioned`.
- Routes: `GET /api/auth/config`, `GET /api/auth/sso/login`, `GET /api/auth/sso/callback`. SSO users are exempt from local TOTP.
- UI: "Sign in with SSO" only when `ssoEnabled`; password form hidden when `localEnabled=false`; `/sso-callback` landing page with error state.
- IaC (authored, NOT deployed): `infra/lib/cognito-construct.ts` (user pool with TOTP MFA required, hosted-UI domain, code-grant app client with secret, 4 groups, optional Google IdP from a Secrets Manager secret via dynamic references, outputs for issuer/client id/hosted UI). Wired into the stack behind context `enableCognito` (default off). Assertions added to `infra/test/app-table.check.ts`.
- Docs: `docs/AUTH_MFA_SSO.md`; `.env.example` updated.

## Files
New: `packages/backend/src/{config/authConfig.ts, lib/totp.ts, lib/totp.test.ts, services/mfaService.ts, services/ssoService.ts, routes/mfa.test.ts, routes/sso.test.ts, db/migrations/003_dpi2_mfa_sso.sql}`, `packages/frontend/src/{components/MfaEnroll.tsx, pages/Security.tsx, pages/SsoCallback.tsx}`, `infra/lib/cognito-construct.ts`, `docs/AUTH_MFA_SSO.md`.
Changed: `authService`, `userService`, `authRoutes`, `userRoutes`, `middleware/auth.ts` (scoped tokens, `requireAuthOrEnroll`), `middleware/rateLimit.ts` (test-only `RATE_LIMIT_DISABLED=1` switch, set in `test/setup.ts`), `auditMetadata.ts`, repository types + both user repositories, `repositoryContract.ts`, `migrations.test.ts`, shared `domain.ts`, frontend Login/AuthContext/App/Layout/Users/api, infra stack + check, `.env.example`, backend `package.json` + lockfile.

## Tests
Default suite: **395 passed / 86 skipped** (was 347 / 83): +48 passed, +3 skipped (the new DynamoDB-gated contract cases).
- `totp.test.ts` (RFC 6238 vectors at six timestamps, RFC 4226 vectors, window, base32, otpauth URI, AES-GCM round trip + tamper, key rules, recovery codes, redaction).
- `mfa.test.ts` (16): enrol/confirm happy path, wrong code, encrypted-at-rest, mfaRequired + scoped token, mfaToken blocked everywhere else, replay, lockout (+ recovery after 15 min), recovery single use, disable/regenerate need password + code, reset Super Admin only (403 others), policy-required enrolment, per-IP limit, secrets never in audit.
- `sso.test.ts` (15) against an in-process fake OIDC provider with a test JWKS and PKCE check: success, bad state, no cookie, wrong nonce, expired, wrong audience, wrong issuer, bad signature, unverified email, missing email, wrong domain, `"true"` string, highest-privilege mapping, unmapped denied, HTML error page, auto-provision, role re-sync, deactivated blocked, auto-provision off, code replay, local login disabled, config endpoint.
- Contract `C-UR-MFA-01..03` (security state, replay claim, recovery consume) run on SQLite by default; DynamoDB variants are gated.

## Verification (run once)
- `npm run build` (root): pass.
- `npm test` (root): 395 passed / 86 skipped.
- `npx tsc -b --noEmit` in `packages/frontend`: clean.
- `cd infra && npx tsc --noEmit`: clean; `npm run check` (offline synth assertions, incl. Cognito off by default and on with context): pass.
- Smoke on port 4100 (SQLite under `.tmp`, `INTEGRATION_MODE=mock`): create user, enrol (code computed from the secret), login returns mfaRequired and no token, mfaToken refused on `/dashboard/summary`, wrong code 401, verify returns a session that works, recovery code works once and then 401. Server stopped; temp files removed.
- DynamoDB-gated cases: NOT run. The Docker CLI exists but the daemon was not running, so there was no DynamoDB Local.
- Incident to disclose: my shell inherited `DB_DRIVER=dynamodb` from the session, so the first smoke attempt started the server against the DynamoDB driver. It failed at credential resolution (`CredentialsProviderError`) before any AWS request completed, and `seed` was refused by its own AWS guard. No AWS resource was read or changed. I then reset `DB_DRIVER=sqlite` and re-ran the smoke.

## Honest limits
- **OIDC / Cognito / Google were NOT exercised against real providers.** SSO is proven only against a local fake provider; real discovery documents, Cognito token shape, Google group handling and the hosted UI are unverified.
- **The UI was not exercised in a browser.** Frontend changes are covered by the type check and build only.
- The Cognito CDK construct is authored and synth-checked offline; it was never deployed.
- The SQLite-to-DynamoDB copy script does not carry MFA state (users re-enrol after migration).
- Rotating `MFA_ENCRYPTION_KEY` invalidates enrolments (no key versioning yet). The per-IP rate limiter is in memory (per ECS task); the per-user lockout is shared via the database.
- MFA policy is checked at login; sessions issued before a policy change are not revoked.
- An SSO login for an email that already has a local user converts that record to SSO (local password login off). Keep the break-glass admin on an email that is not in the IdP.

## To go LIVE / client input needed
1. Google Workspace admin access (create the OAuth client; enforce 2-step verification for the domain) and the AWS account/region for Cognito.
2. Group (or user) to role mapping, and who maintains membership. Set `OIDC_GROUP_ROLE_MAP`; Google sends no groups, so users must be placed in the Cognito groups.
3. Decision: SSO, TOTP only, or both; whether `AUTH_LOCAL_ENABLED` stays true (break-glass).
4. `MFA_REQUIRED_ROLES` policy (default optional is a placeholder).
5. Secrets Manager entries: `MFA_ENCRYPTION_KEY` (32 bytes base64), `OIDC_CLIENT_SECRET`, and the Google `{client_id, client_secret}` secret.
6. Cognito hosted-UI domain prefix and production callback URL(s); then deploy with `-c enableCognito=true -c cognitoCallbackUrls=... -c cognitoGoogleSecretArn=...` (item 14 / deploy approval) and set `AUTH_PROVIDER=oidc` plus the `OIDC_*` task environment.
7. A test run with a real Cognito pool and Google login before relying on SSO.
