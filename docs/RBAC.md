# Role-based access control (DPI 2, item 2)

> **DRAFT.** The role-to-permission matrix below is a proposal pending Urbani sign-off (client input #11). It lives in one place: `packages/shared/src/rbac.ts` (`ROLE_PERMISSIONS`). Backend and frontend both read it.

## Roles

| Role | Display name |
|---|---|
| `SUPER_ADMIN` | Super Admin |
| `INFRA_ADMIN` | Infrastructure Administrator |
| `QA_OPERATOR` | QA Operator |
| `READER_AUDITOR` | Reader / Auditor |

Existing DPI 1 users became `SUPER_ADMIN` through the item 1 migration default, so they keep full access.

## Draft permission matrix

| Permission | Super Admin | Infra Admin | QA Operator | Reader / Auditor |
|---|:-:|:-:|:-:|:-:|
| dashboard:view, alerts:view, logs:view, metrics:view, services:view, ai:view, usage:view, settings:view | yes | yes | yes | yes |
| alerts:acknowledge | yes | yes | yes | no |
| ai:analyze | yes | yes | yes | no |
| chat:use (read-only advisory) | yes | yes | yes | yes (judgment call) |
| logs:export (covers ALL exports: logs, alerts, incident report; item 11) | yes | yes | yes | yes |
| alerts:rules (placeholder, item 6) | yes | yes | no | no |
| settings:update | yes | yes | no | no |
| audit:view | yes | yes | no | yes |
| users:manage | yes | no | no | no |

**Chat history and feedback (item 8).** The history and feedback routes (GET/PATCH/DELETE /api/chat/sessions..., PUT /api/chat/messages/:id/feedback) need chat:use AND are owner-only: nobody, Super Admin included, can read another user's conversation (404). The feedback quality summary GET /api/chat/feedback/summary reuses udit:view (Super Admin, Infra Admin, Reader / Auditor; same roles, no new permission) and returns aggregates and de-identified dislike comments only. DRAFT, pending sign-off like the rest of the matrix; see [CHAT.md](CHAT.md).

Reader / Auditor holds no mutating permission (no acknowledge, analyze, settings update or user management). `chat:use` is allowed because the assistant is read-only advisory; Urbani may remove it.

## How enforcement works

- `requireAuth` verifies the JWT, then loads the user on every request. A role change or deactivation applies on the next request. A deactivated user's token returns `401`.
- `requirePermission('x:y')` (in `middleware/auth.ts`) guards each route. Unauthenticated: `401`. Authenticated but not allowed: `403` with `{ "error": { "code": "FORBIDDEN", "message": "..." } }`, and an `access.denied` audit event.
- `GET /api/auth/me` and the login response return `rbacRole`, `rbacRoleName` and the effective `permissions` list. (`role` is the legacy roles-table label and is unchanged.)
- The UI hides navigation and buttons the role cannot use and shows "You do not have permission" for direct URLs. This is convenience only; the API is the enforcement point.

## Add a permission

1. Add the name to `PERMISSIONS` in `packages/shared/src/rbac.ts`.
2. Grant it to roles in `ROLE_PERMISSIONS`.
3. Guard the route with `requirePermission('name')` in `packages/backend/src/routes/`.
4. Add a row to the route table in `packages/backend/src/routes/rbac.test.ts`.
5. In the UI, use `useAuth().can('name')` or add `permission` to a `NAV_SECTIONS` entry.
6. Update the table above.

## User management API (`users:manage`, Super Admin only)

| Method and path | Body | Notes |
|---|---|---|
| `GET /api/users` | | All users, active and inactive. Never returns password hashes. |
| `POST /api/users` | `email`, `displayName`, `role`, `password` (min 10) | `201`. Role is required. Email is stored lowercase. Duplicate email: `409`. |
| `PUT /api/users/:id/role` | `role` | You cannot change your own role. Cannot demote the last active Super Admin. |
| `POST /api/users/:id/deactivate` | | Cannot deactivate yourself or the last active Super Admin. |
| `POST /api/users/:id/activate` | | |
| `POST /api/users/:id/reset-password` | `password` (min 10) | |

Guard rail violations return `409 CONFLICT`. Audit actions written: `user.create`, `user.role_change`, `user.activate`, `user.deactivate`, `user.password_reset`, `auth.login_failed`, `access.denied`. Successful logins still use the existing `LOGIN` action.

## Service health and preferences (items 9 and 10)

| Route | Permission |
|---|---|
| `GET /api/health/status`, `GET /api/health/history` | `services:view` (all four roles) |
| `POST /api/health/check-now` | `settings:update` (Super Admin, Infra Admin); rate limited (5/min), audited as `health.check_now` |
| `GET` / `PUT /api/preferences` | any authenticated user, own preferences only |

No new permission was added; the matrix is unchanged.