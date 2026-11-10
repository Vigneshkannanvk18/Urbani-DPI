# DPI 2 item 2 report: RBAC (4 roles) + user management

- **Status:** DONE (integration pending). LEAN mode: no design/review loop.
- **Branch / commit:** `dpi2` in `.worktrees\dpi2`, commit `1b3b3d361386520021e6a4c2166f96eacaa1aac8` (on top of `4cb8eff`). Not pushed.

## What was built
- **Shared:** `packages/shared/src/rbac.ts` with `PERMISSIONS`, `ROLE_DISPLAY_NAMES`, `ROLE_PERMISSIONS` (the single, DRAFT matrix), `permissionsForRole`, `roleHasPermission`. New audit actions in `AUDIT_ACTIONS`.
- **API enforcement:** `requireAuth` now loads the user on every request (role change and deactivation apply immediately; deactivated token = 401). `requirePermission(...)` applied to every route in `apiRoutes.ts`. 403 returns `FORBIDDEN` JSON and writes an `access.denied` audit event. `/auth/me` and login return `rbacRole`, `rbacRoleName` and the effective `permissions`.
- **User management** (`users:manage`): `GET/POST /api/users`, `PUT /api/users/:id/role`, `POST .../deactivate|activate|reset-password`. bcrypt, min password 10, role required on create. Guard rails: no self role change, no self deactivation, last active Super Admin protected, duplicate email 409. Audit: `user.create`, `user.role_change`, `user.activate`, `user.deactivate`, `user.password_reset`, `auth.login_failed`, `access.denied`.
- **Repositories:** `users.getById` (includes inactive) and `users.list` added to the interface, SQLite and DynamoDB drivers, plus contract test C-UR-12.
- **UI:** auth context `can()`, nav filtered by permission, role badge in header, Acknowledge hidden and Analyze disabled without permission, assistant widget gated by `chat:use`, `RequirePermission` route guard with a "You do not have permission" screen, new `Users` page (list, create, change role, deactivate/activate, reset password).
- **Docs:** `docs/RBAC.md`. No new env vars (`.env.example` unchanged).

## Notes / deviations
- `AuthUser.role` stays the legacy roles-table label (existing `authService` test expects `ADMIN`); the RBAC role is the new field `rbacRole`. The additive keys `user.rbacRole` / `user.rbacRoleName` were added to steps 03 and 04 of `routes.baseline.json` (additive API change, no key removed).
- Successful login keeps the existing `LOGIN` audit action (not renamed to `auth.login`) to keep DPI 1 audit data consistent.
- Frontend imports runtime RBAC constants via `@urbani/shared/rbac` (aliased to source in `vite.config.ts`, same pattern as markdown), because the CJS barrel is not statically analysable by Rollup.
- The last-active-Super-Admin rule cannot be hit through HTTP today (only Super Admins can manage users, and self changes are blocked); it is tested at service level as defence in depth.
- Users page "Reset password" uses a browser prompt (lean, cosmetic).
- Migration 002 column default `SUPER_ADMIN` is unchanged; create-user now always requires an explicit role (item 1 follow-up). Dropping the default is left for a later migration.
- Email is stored lowercase on create; login matches exactly as before.

## Tests
- New `routes/rbac.test.ts`: 19 tests (401 on every route; per-role 200/403 matrix for all 4 roles over 21 routes; dedicated READER_AUDITOR no-mutation test; /auth/me; validation; duplicate email; self-protection; last-super-admin; immediate role change; deactivation and token invalidation; password reset; audit events; 404).
- New contract case C-UR-12 (sqlite always; dynamodb opt-in).
- Totals: **280 passed, 81 skipped** (DynamoDB opt-in), 23 files passed (was 260 / 80). All pre-existing tests unchanged and passing.

## Verification (run once on the final tree)
- `npm run build` (root): exit 0.
- `npm test` (root): exit 0, 280 passed / 81 skipped. DynamoDB Local was not run in this item (no new DynamoDB-specific logic beyond `list`/`getById`; contract case C-UR-12 is in the opt-in suite and unexercised against DynamoDB Local).
- `npx tsc -b --noEmit` in packages/frontend: exit 0.
- Smoke on port 4100 with a worktree-local SQLite file: seeded admin `/auth/me` = SUPER_ADMIN with 16 permissions; created a READER_AUDITOR; it logged in, `GET /api/alerts` = 200, `POST .../acknowledge` = 403, `PUT /api/settings` = 403. Server stopped, port free, temp DB removed. (The `GET /api/users` = 403 check printed status 0 in PowerShell because of a body on a GET; it is covered by the supertest suite.) UI was not exercised in a browser.

## DRAFT permission matrix (pending Urbani sign-off, client input #11)
| Permission | Super Admin | Infra Admin | QA Operator | Reader / Auditor |
|---|:-:|:-:|:-:|:-:|
| *:view (dashboard, alerts, logs, metrics, services, ai, usage, settings) | yes | yes | yes | yes |
| alerts:acknowledge | yes | yes | yes | no |
| ai:analyze | yes | yes | yes | no |
| chat:use | yes | yes | yes | yes (judgment call: read-only advisory) |
| logs:export (placeholder) | yes | yes | yes | yes |
| alerts:rules (placeholder) | yes | yes | no | no |
| settings:update | yes | yes | no | no |
| audit:view | yes | yes | no | yes |
| users:manage | yes | no | no | no |

## To go LIVE / client input needed
1. **Sign-off of the permission matrix** (client input #11), including: chat for Reader / Auditor, whether QA Operator may see Settings and Usage, whether Infra Admin may view the audit log. Change only `ROLE_PERMISSIONS` in `packages/shared/src/rbac.ts`.
2. **Google group to role mapping** for item 5 (SSO): which Google Workspace group maps to each of the 4 roles, and the default role for an unmapped user (suggest: no access).
3. After deploy: rotate the DPI 1 admin password (it is Super Admin) and create the real named users from the Users page.
4. Optional later migration: drop the `DEFAULT 'SUPER_ADMIN'` on `users.role`.