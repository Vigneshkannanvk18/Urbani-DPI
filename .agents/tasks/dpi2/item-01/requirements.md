# DPI 2 item 1: Persistence foundation. Requirements

Revision 3. It resolves findings 22–29 from the second design review in `design-review.md`. The requirement-level changes of revisions 2 and 3 are listed at the end of this file. Companion design: `design.md` in this folder (Revision 3); its §17 and §18 answer each finding.
Worktree: `C:\Antigravity\Urbani DPI\.worktrees\dpi2` (branch `dpi2`, created from `main` at `5cc5ffa`; dpi2 HEAD at setup `5c81908`).

## Summary

The backend's persistence layer becomes asynchronous and driver-agnostic. SQLite stays the default driver and must behave exactly as DPI 1 does today. A new DynamoDB driver stores every entity persisted today, plus the data later DPI 2 items need: a `role` on users, per-user preferences, audit results with time-range and per-user queries, and chat sessions, messages and feedback. The item also delivers one repository contract test suite that runs against both drivers, DynamoDB Local tooling, an idempotent SQLite-to-DynamoDB copy script, IaC that is authored but not deployed, and documentation. All work happens in the dpi2 worktree. Nothing in this item calls AWS.

## Functional requirements

### FR1. Async, driver-agnostic repository layer
- FR1.1 `packages/backend/src/repositories/types.ts` defines one TypeScript interface per entity repository: alerts, services, environments, logs, metrics, usage, AI analyses, audit, integrations, users (with roles), preferences, chat, health.
- FR1.2 Every repository method returns a `Promise`. Every caller awaits it. The callers are the services, routes, `db/seed.ts`, `integrations/mock/MockDynamoDBAdapter.ts`, `routes/healthRoutes.ts`, `server.ts` and the tests.
- FR1.3 `getRepositories()` builds the driver's repositories once, chosen from `config.db.driver` (`sqlite` by default, or `dynamodb`). `setRepositoriesForTesting()` and `resetRepositories()` let tests inject repositories, following the existing `integrations/index.ts` pattern.
- FR1.4 Only `packages/backend/src/repositories/**`, the DB tooling in `packages/backend/src/db/**` and test helpers in `packages/backend/src/test/**` may import `better-sqlite3`, `db/connection` or `@aws-sdk/*`. Services and routes reach the database only through repositories.

### FR2. SQLite parity (DB_DRIVER=sqlite, the default)
- FR2.1 The SQLite driver keeps today's SQL and semantics. The single exception is FR2.5. That covers filters, sort order, pagination clamps, counts, acknowledge, the status-preserving live upsert, the side effects of `INSERT OR REPLACE` (child cascades and link unlinking), the cascade in delete-by-data-source, and the `LIKE` search behavior.
- FR2.2 The raw SQL in `db/seed.ts` moves into repository methods with the same SQL effects.
- FR2.3 The HTTP API is unchanged: same routes, same status codes, same JSON shapes for every endpoint. This includes `/api/auth/login` and `/api/auth/me` (where `user.role` is still the roles-table name, for example `ADMIN`), `/api/audit` items (no new keys) and the `/ready` body.
- FR2.4 A new forward-only migration `002_dpi2_persistence_foundation.sql` makes these changes:
  - adds `users.role`, `NOT NULL DEFAULT 'SUPER_ADMIN'`, with a CHECK over the 4 role values, so every existing user becomes Super Admin;
  - adds `audit_events.result`, `NOT NULL DEFAULT 'SUCCESS'`, with a CHECK, and backfills `FAILURE` for recorded failed chat turns;
  - adds an `(actor, timestamp)` index on `audit_events`;
  - creates the `user_preferences`, `chat_sessions`, `chat_messages` and `chat_feedback` tables.

  DPI 1 code must keep working against a database that has 002 applied. The `user_id` columns of the new tables do not get a foreign key to `users`. Writes to `users`, including the legacy REPLACE semantics that DPI 1 code still uses on a migrated DB, can therefore never cascade-delete a user's preferences or chats. This also matches DynamoDB, which has no cascades. Both drivers check that the user exists instead. A user **exists** when a user row with that id exists, whatever `is_active` is (assumption A8).
- FR2.5 There is one deliberate SQLite semantic change. `upsertUser` switches from `INSERT OR REPLACE` to `INSERT … ON CONFLICT(id) DO UPDATE`. Today, upserting a user with another user's email silently deletes that other user (verified). After the change the upsert is rejected, which makes email uniqueness identical on both drivers. No DPI 1 flow reaches this path: the only callers are the seed, which is guarded by `findByEmail` and nothing deactivates users, and the tests. For a same-id upsert the effect is unchanged.

### FR3. New capabilities (both drivers)
- FR3.1 Users carry `role` ∈ {`SUPER_ADMIN`, `INFRA_ADMIN`, `QA_OPERATOR`, `READER_AUDITOR`}. A new user gets `SUPER_ADMIN` when no role is supplied. An upsert of an existing user that omits `role` keeps the stored role, so omission never escalates privilege. An invalid role is rejected. The role is stored but not enforced (enforcement is item 2). Because of this default, item 2's create-user path must require an explicit role; the ADR and the item report record that follow-up.
- FR3.2 Per-user preferences hold `theme` (`light` | `dark` | null) and `widgetLayout` (an opaque JSON value, at most 16 KiB serialized, or null). The repository supports get and partial update.
- FR3.3 Audit events carry `result` (`SUCCESS` | `FAILURE` | `DENIED`). `listByTimeRange({ from?, to?, actor?, limit?, cursor? })` returns events newest first with cursor pagination, so events can be queried by time range and by user. The existing chat failure path records `FAILURE`. A cursor is accepted only when it is well-formed and, for audit, its timestamp lies within the request's `from`/`to`. Otherwise both drivers reject it with `INVALID_CURSOR` before any query runs.
- FR3.4 The chat repository supports: create and get a session; list one user's sessions, most recent activity first; append a message (role, content, citations, provenance source, provider/model, token counts, latency); list a session's messages oldest first; set and list feedback (`LIKE` | `DISLIKE`, one per message). Creating a session and setting feedback require an existing user (FR2.4). Feedback also requires a message of that session.

### FR4. DynamoDB driver
- FR4.1 The driver implements every interface using the single-table model in the design and ADR: one table `<DYNAMODB_TABLE_PREFIX>App` with keys `PK`/`SK` and one GSI `GSI1`.
- FR4.2 Writes that need it for correctness are conditional or transactional:
  - unique user email, through a transactional lock item. The user write is conditioned on the state read before it, so concurrent upserts of one user never leave an old email lock behind. `findByEmail` returns a user only when the user's stored email equals the requested email;
  - `upsertLivePreservingStatus` is one atomic update that never reverts status or acknowledgement;
  - `acknowledge` succeeds only when the alert is `OPEN`;
  - `deleteByDataSource` deletes each alert conditionally and cascades to evidence, actions and links;
  - updates that mirror a SQL `UPDATE` never create items that do not exist. Only the upsert-style writes create items through an update: the live alert upsert, preferences and feedback (FR4.11);
  - appending a chat message is one transaction;
  - setting feedback checks the message and the user in the same transaction as the write.
- FR4.3 Every base-table read is strongly consistent, including the readiness ping, so reads that SQLite serves with read-after-write consistency keep it. Only `GSI1` lookups are eventually consistent, and each one is documented.
- FR4.4 Alert evidence that exceeds a 256 KiB budget is trimmed by whole trailing lines and a warning is logged. Line text is never altered. Any item still estimated above 380 KiB fails with `PersistenceError` `ITEM_TOO_LARGE`.
- FR4.5 New config: `DYNAMODB_TABLE_PREFIX` (default `Urbani`) and `DYNAMODB_ENDPOINT` (optional URL). When the endpoint is set, dummy static credentials are used. Otherwise the AWS default credential chain applies. No real credentials appear in code.
- FR4.6 `docs/adr/0001-dynamodb-persistence.md` in the worktree records the decision, the key schema, the access-pattern table, the accepted divergences (FR4.10) and the scale thresholds (NFR4).
- FR4.7 Pagination. Every DynamoDB Query reads every page, or pages until the requested number of items. Counts sum `Count` over every page. Only the shared helpers in `repositories/dynamodb/ops.ts` send Query, BatchGetItem and BatchWriteItem commands.
- FR4.8 Search. The emulation of SQLite `LIKE '%term%'` builds no regular expression from user input. Its cost per value is at most proportional to the value length times the term length, and it returns exactly SQLite's result: case folding for ASCII letters only, `_` matches one character, `%` matches any run.
- FR4.9 Key limits. A lookup whose key would exceed DynamoDB's limits (2,048 bytes for a partition key, 1,024 bytes for a sort key) returns the not-found result without a call, which is what SQLite returns for such an id. A write with such a key is rejected with `INVALID_ARGUMENT`.
- FR4.10 Accepted divergences. DynamoDB does not enforce SQLite's secondary UNIQUE constraints: `roles.name`, `services(name, environment)`, `environments.name`, and the `id` side of `usage_records`. Only the seed (static ids) and the migration (whose source already satisfies them) write these entities. The ADR lists the divergences.
- FR4.11 Every item that the driver or the migration writes carries an `entityType` attribute naming its entity. There are 16 values, and the never-written health sentinel is the only item without one. The rule covers email locks and items that an UpdateItem creates: a new LIVE alert, the first preferences write and the first feedback on a message. Preferences items also carry `userId`. Item 6's Streams consumer will filter on `entityType`, so no item may ever need a backfill.

### FR5. Tests
- FR5.1 One contract suite, `packages/backend/src/test/repositoryContract.ts`, runs for both drivers from `packages/backend/src/repositories/repositories.contract.test.ts`.
- FR5.2 The SQLite run is part of the default `npm test`. The DynamoDB run executes only when `DYNAMODB_ENDPOINT` is set. Otherwise it is reported as skipped.
- FR5.3 Every test file with a DynamoDB block creates its own uniquely named table, purges it before each test and deletes it after the file. That covers the contract suite and the opt-in seed, migration and DynamoDB-only tests. No test reads or writes the configured `<prefix>App` table. Each DynamoDB test has a 20 s timeout.
- FR5.4 The existing 73 tests keep passing. Edits to them are limited to:
  - async/await;
  - obtaining repositories through the registry;
  - one type-only edit: `services/alertService.test.ts`, `services/authService.test.ts` and `services/chatService.test.ts` drop `import type Database from 'better-sqlite3'` and declare their handle as `ReturnType<typeof freshTestDb>`. The type is identical. Without this edit the FR1.4 import rule fails on these files.

  No assertion is removed or weakened.
- FR5.5 The default suite also gets these tests:
  - migration 002 applied to a populated 001 database;
  - seed on SQLite, including idempotency, and the seed's AWS guard (FR6.3);
  - registry driver selection;
  - config parsing;
  - DynamoDB pure units (keys, item mappers, evidence budget, cursor codec and cursor schemas);
  - the LIKE emulation, cross-checked against SQLite `LIKE` and with a timing case for a pathological term (FR4.8);
  - DynamoDB command-shape and error-path tests against a fake client, including two-page Query results (FR4.7) and the `upsertUser` retry paths;
  - `entityType` on every item builder's output and in the three create-capable UpdateItems (FR4.11);
  - CLI argument and exit-code tests (FR6.2, FR7.3), including relative `--source` resolution (FR7.1);
  - HTTP route shape tests with supertest, replaying the fixed request sequence of AC7;
  - the SQLite reader used by the migration script.

### FR6. Dev tooling
- FR6.1 `docker-compose.yml` gets a `dynamodb-local` service under the profile `dynamodb`, bound to `127.0.0.1:8000` and run with `-sharedDb -inMemory`. An equivalent `docker run` command is documented.
- FR6.2 `npm run dynamo:tables` creates the table, or deletes and recreates it with `--reset`. It runs only when `DYNAMODB_ENDPOINT` is set (a presence check) and refuses otherwise. Refusals, bad flags and configuration errors exit 2; a failed call exits 1.
- FR6.3 `npm run seed` works for both drivers and is idempotent. With `DB_DRIVER=dynamodb` and no `DYNAMODB_ENDPOINT` it refuses with exit 2 unless `--allow-aws` is passed, so demo data cannot reach an AWS table by accident.
- FR6.4 `npm run reset --workspace @urbani/backend` refuses when `DB_DRIVER=dynamodb`: it exits 1 with a message naming `dynamo:tables -- --reset`, without opening a SQLite file. `npm run migrate` is a logged no-op for `dynamodb`.
- FR6.5 DynamoDB Local runs from the Docker Hub image. When no Docker engine is available, the official DynamoDB Local jar on a Java 11+ runtime is an allowed fallback.

### FR7. SQLite to DynamoDB migration script
- FR7.1 `npm run dynamo:migrate -- --source <path> [--dry-run] [--allow-aws]` copies every entity, including alert evidence, actions and alert↔log/metric/analysis links. `--source` is required: there is no default path, because the configured default resolves into `packages/backend/data/`. A relative `--source` resolves against `INIT_CWD` when npm sets it, otherwise against the working directory. It does not resolve against the script's working directory, which npm sets to `packages/backend`. Through the root alias `INIT_CWD` is the repository root (verified with npm 11.6.2), so the documentation uses absolute paths. The script prints the resolved absolute path before it checks or opens the file. It opens the SQLite file read-only. It accepts both 001-only and 002 schemas: a missing `role` maps to `SUPER_ADMIN` and a missing `result` to `SUCCESS`, with the same `FAILURE` backfill rule.
- FR7.2 The script is idempotent. Writes are create-only, so a re-run reports everything as skipped and never overwrites DynamoDB data.
- FR7.3 It prints per-entity counts (source, created or would-create, skipped or would-skip, failed) and totals. Exit codes: 0 = no failures, 1 = some items failed, 2 = precondition or configuration error (including an invalid environment variable).
- FR7.4 It refuses to run without `DYNAMODB_ENDPOINT` unless `--allow-aws` is given. In this item it is only ever run against DynamoDB Local.

### FR8. IaC (authored only, never deployed)
- FR8.1 `infra/lib/persistence-construct.ts` adds the app table with `PK`/`SK`, `GSI1` (projection ALL), on-demand billing, the shared CMK, PITR and RETAIN, and a `grantAppDataAccess(grantee)` method.
- FR8.2 `infra/lib/security-construct.ts` adds `dashboardTaskRole` with the `ecs-tasks.amazonaws.com` principal. The role is granted exactly these permissions:
  - `dynamodb:GetItem`, `BatchGetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `ConditionCheckItem` on the app table ARN and its `GSI1` index ARN;
  - `kms:Decrypt`, `kms:Encrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*` on the CMK, only through DynamoDB in the stack region. These are CDK's `grantReadWriteData` key actions minus `kms:DescribeKey`.

  It gets no Scan, DescribeTable, table-admin or Streams permissions, and nothing on `UrbaniAlerts`.
- FR8.3 `infra/lib/dashboard-construct.ts` uses that role as the task role. Its `DB_DRIVER` env stays `sqlite`. `deploy-ecs.sh` and `redeploy.sh` are not modified.
- FR8.4 `cd infra && npx tsc --noEmit` passes. `npm run check` in `infra/` synthesizes the stack in process with `aws-cdk-lib/assertions` (no CDK CLI) and confirms the FR8.1 table properties and the exact FR8.2 statements.

### FR9. Documentation
- FR9.1 `.env.example` in the worktree documents the new variables and gains a "Persistence drivers" section covering DynamoDB Local, table creation, seed, migration and switching `DB_DRIVER`. Every command appears in bash and in PowerShell form.
- FR9.2 The ADR from FR4.6 is written. The `infra/README.md` construct table reflects the new table and role.

## Non-functional requirements
- NFR1 No AWS API calls and no use of AWS credentials during this item: nothing may read or change resources in any AWS account. The CDK CLI is not run, because it contacts AWS-hosted endpoints. Anonymous downloads of public artifacts are allowed: npm packages, the Docker Hub image, and the DynamoDB Local jar from its public URL. The guards in FR6.2, FR6.3 and FR7.4 enforce this for the tooling. No `cdk deploy`, `deploy-ecs.sh` or `redeploy.sh`.
- NFR2 The default `npm test` needs no Docker, AWS or network access.
- NFR3 Security: least-privilege IAM. No secrets in code, logs or commits. The DynamoDB driver logs operation names, ids, counts and AWS error names, never item contents such as password hashes, emails or chat text. Warnings about inconsistent data (for example an email lock that does not match its user) carry ids only.
- NFR4 Performance: list endpoints and dashboard counts on DynamoDB read whole entity partitions. The ADR documents their size and read-unit cost and sets the threshold at which this must change: about 1,000 alerts, or 3 MB in any one entity partition.
- NFR5 Workspace hygiene:
  - work only in the worktree; `main` and the main workspace stay untouched;
  - runtime databases live under `<worktree>/.tmp/`. Adding `.tmp/` to `.gitignore` is the item's first action, before any runtime file exists, because the existing `*.sqlite` rule does not match `-wal`/`-shm` sidecars;
  - every seed, server and CLI run sets `DATABASE_URL` to a path under `.tmp/`, so the default `./data/urbani.sqlite` never applies;
  - never open `packages/backend/data/*` in either checkout (the worktree copy contains tracked stale `-wal`/`-shm` files); the migration script therefore has no default source path;
  - use ports 4100 (API) and 8000 (DynamoDB Local), and stop every process started;
  - never commit `.env` files.
- NFR6 Follow the existing code style: plain-object/factory repositories, zod validation, the structured `logger`, `Sourced<T>` envelopes and the LIVE/MOCK/WAITING_FOR_INTEGRATION provenance labels. Never fabricate data.

## Acceptance criteria
1. `npm run build` at the worktree root exits 0 for shared, backend and frontend.
2. `npm test` at the worktree root, with `DYNAMODB_ENDPOINT` unset, exits 0 with no network access. All 73 pre-existing tests pass alongside the new ones. `repository contract [sqlite]` passes all of its cases (69 in design §8.2) and `repository contract [dynamodb]` is reported as skipped.
3. `npx tsc -b --noEmit` in `packages/frontend` reports no errors.
4. `cd infra && npm ci && npx tsc --noEmit && npm run check` exits 0.
5. A grep over `packages/backend/src`, test files included, finds no import of `better-sqlite3`, `db/connection` or `@aws-sdk/` outside `repositories/**`, `db/**` and `test/**`.
6. A review plus grep finds no un-awaited repository call (no floating promises) in services, routes, `db/seed.ts`, the mock adapter or `server.ts`.
7. With `DB_DRIVER=sqlite`, a fixed 27-step request sequence (design §14 step 1) gives, at every step, the same HTTP status and the same recursive key set as a baseline captured from the unmodified dpi2 build. The sequence covers, in a fixed order: `/health`, `/ready`, login, me, dashboard summary and health, alerts list, detail, missing detail (404) and acknowledge, logs, metrics, services list, detail and missing detail (404), usage, usage/cost, settings GET and PUT, the AI analyses list before and after the writes, the analysis detail, `POST /api/ai/analyze`, `POST /api/chat`, audit before and after the writes, and logout. Key sets are recorded per step, not per endpoint. Two checks replay the sequence: the supertest route tests (FR5.5), against the committed fixture `routes.baseline.json`, and the port-4100 smoke test.
8. Migration 002 test: a user created under 001 has `role = 'SUPER_ADMIN'`. An audit row whose metadata `outcome` is `'unavailable'` has `result = 'FAILURE'`, and other rows have `'SUCCESS'`. The 4 new tables exist. Running migrations again applies nothing. An invalid role value is rejected.
9. The contract suite contains every case listed in design §8.2 and passes on SQLite. This includes:
    - upserting a user with another user's email rejects and leaves the original user intact (FR2.5);
    - an upsert that omits `role` keeps the stored role (FR3.1);
    - upserting an existing user does not delete that user's preferences or chat sessions;
    - two concurrent email changes of one user, and two concurrent creates of one id, leave exactly one email lock for that user (FR4.2);
    - feedback by an unknown user is rejected, and an inactive user can still set preferences (FR2.4);
    - an audit cursor whose timestamp lies outside `from`/`to` is rejected with `INVALID_CURSOR` (FR3.3).
10. If Docker (or the jar fallback of FR6.5) is available:
    - DynamoDB Local starts and `dynamo:tables` creates the table;
    - with `DYNAMODB_ENDPOINT` set, `repository contract [dynamodb]` passes with 0 skipped;
    - the seed runs twice without error, and afterwards the alert, service and usage totals equal those of the SQLite smoke test;
    - the migration `--dry-run` prints counts and writes nothing, a real run creates items, and a second run reports every item as skipped;
    - the port-4100 smoke test with `DB_DRIVER=dynamodb` returns the same status and key set as the baseline at every step of the AC7 sequence;
    - the container or process is then stopped.

    If neither is available, the report states that DynamoDB Local was NOT exercised.
11. The tooling guards hold, and none of them makes an AWS call:
    - `dynamo:tables` without `DYNAMODB_ENDPOINT` exits 2;
    - `dynamo:migrate` without `DYNAMODB_ENDPOINT` and without `--allow-aws` exits 2;
    - `dynamo:migrate` with an invalid `DYNAMODB_ENDPOINT` (for example `ftp://x`) exits 2;
    - `npm run seed` with `DB_DRIVER=dynamodb`, no `DYNAMODB_ENDPOINT` and no `--allow-aws` exits 2;
    - `npm run reset --workspace @urbani/backend` with `DB_DRIVER=dynamodb` exits 1, names `dynamo:tables -- --reset`, and creates no SQLite file.
12. With `DB_DRIVER` unset, `getRepositories().driver === 'sqlite'`. With `DB_DRIVER=dynamodb` it is `'dynamodb'`, and constructing it performs no network call.
13. Config: `DYNAMODB_ENDPOINT=` (empty) is treated as unset. A non-http(s) or invalid URL fails startup with a message naming the variable. The table name resolves to `${DYNAMODB_TABLE_PREFIX}App`, which is `UrbaniApp` by default.
14. The IaC code defines the app table with `GSI1`, the CMK, PITR and RETAIN. `npm run check` in `infra/` asserts these properties and that the dashboard task role has exactly the two statements of FR8.2, with nothing on `UrbaniAlerts` and no Scan. The CDK CLI (`cdk synth`) is not run.
15. `.env.example` contains `DYNAMODB_TABLE_PREFIX`, `DYNAMODB_ENDPOINT` and the "Persistence drivers" section, with bash and PowerShell forms. The ADR exists with the decision, the access-pattern table, the accepted divergences and the scale thresholds.
16. Commits land on `dpi2` only. `main` stays at `5cc5ffa`. Nothing is pushed and the worktree is kept. No `.env`, `.tmp/` or `packages/backend/data/*` changes are committed.
17. Item 1's row in `BACKLOG.md` is updated and its Progress log entry appended. `item-01-report.md` contains: the data model and why (with an ADR link), files changed, test counts, exact verification results including whether DynamoDB Local was exercised, the dpi2 commit hash, a "To go LIVE" section, the type-only test edit allowed by FR5.4, and the item 2 follow-up from FR3.1.
18. The LIKE emulation constructs no `RegExp` from input (a grep finds no `new RegExp` or `RegExp(` under `repositories/`). `common.test.ts` shows that the pathological term `%e%e%e%e%e%e%e%e%z` returns `false` in under 50 ms, and that the emulation agrees with SQLite `LIKE` on its cross-check set.
19. `QueryCommand`, `BatchGetCommand` and `BatchWriteCommand` appear only in `repositories/dynamodb/ops.ts`. The fake-client tests show counts summed and lists concatenated across two Query pages.
20. `entityType` (FR4.11), in the default suite:
    - `items.test.ts` shows that each of the 16 item builders sets its `entityType`;
    - `commands.test.ts` shows that the SET clauses of `upsertLivePreservingStatus`, `preferences.update` and `setFeedback` contain `#entityType`, that `preferences.update` also sets `#userId`, and that the email lock Put carries `entityType: 'USER_EMAIL'`;
    - contract case C-PF-02 shows that `preferences.get(u).userId` equals `u` on SQLite.

    When DynamoDB Local is available, C-PF-02 also passes on DynamoDB, and two table scans find `entityType` on every item: one after every create path has run once, one after a migration run.
21. `dynamo:migrate` prints `Source (read-only): <absolute path>` before it checks or opens the file. `cli.test.ts` shows that a relative `--source` resolves against `INIT_CWD`, or against the working directory when `INIT_CWD` is unset, and that an absolute path is kept. Its `main()` exit-code cases re-import `./cli` after every `vi.resetModules()`.

## Out of scope
- RBAC enforcement, the permission matrix and user-management APIs, including listing and deleting users (item 2). Switching `AuthUser.role` or the JWT `role` claim to the new `users.role` field is also item 2.
- The audit UI, the list of "sensitive" actions, retention and CloudTrail (item 3).
- Chat history and feedback API/UI (item 7), latency display (item 8), preferences API/UI (items 10 and 12).
- Deploy-script changes, multi-task ECS, autoscaling, and flipping `DB_DRIVER` in CDK or `deploy-ecs.sh` (item 14). DynamoDB Streams and the notifier (item 6).
- TTL-based retention, a DynamoDB-to-SQLite reverse migration, Settings page changes, and removing the stale tracked `packages/backend/data/*.sqlite-wal`/`-shm` files from git.
- Running anything against AWS, including the CDK CLI.

## Assumptions (confirmed by the design review unless noted)
- A1 Role machine names are `SUPER_ADMIN`, `INFRA_ADMIN`, `QA_OPERATOR`, `READER_AUDITOR`, mapped from the client's four roles. Display labels and permissions belong to item 2 and need client sign-off.
- A2 Audit `result` values are `SUCCESS`, `FAILURE`, `DENIED`. `DENIED` is reserved for RBAC denials (items 2 and 3).
- A3 Theme values are `light` and `dark`. `null` means "not chosen" (item 10). The widget layout schema belongs to item 12 and is stored as opaque JSON.
- A4 The new enums live in `packages/shared/src/domain.ts`, next to `AUDIT_ACTIONS`. New entity record types stay in the backend until the owning item exposes them over HTTP.
- A5 Additive-only response changes still count as "shape changes" for this item. That is why `/api/audit` keeps its exact `AuditEvent` shape and `result` is exposed only through `listByTimeRange`.
- A6 DPI scale for sizing: tens to low thousands of alerts, thousands to tens of thousands of audit events and AI analyses, and a handful of users.
- A7 The production DynamoDB region will match the ECS service region (`us-east-1` in the current `deploy-ecs.sh`). The CDK default `ap-south-1` must be overridden at deploy time (item 14).
- A8 (new in revision 2) "The user exists" means a user row with that id exists, whatever `is_active` is. That is what a foreign key would check; being active is an authentication rule.
- A9 (new in revision 2) No code deletes users in item 1. The check-then-write user checks for preferences and chat sessions therefore cannot race with a delete. Item 2 revisits this if it adds user deletion.

## Revision 2 changes (requirement level)
- FR2.4, FR3.4, A8, A9: the definition of "user exists"; feedback checks the user (review finding 5).
- FR3.3: audit cursors outside `from`/`to` are rejected on both drivers (finding 4).
- FR4.2: conditioned user write and the `findByEmail` email check (finding 3).
- FR4.7: pagination through shared helpers (finding 2). FR4.8: LIKE emulation without regex (finding 1). FR4.9: key-length parity (found in self-review while fixing finding 15). FR4.10: accepted divergences (finding 8).
- FR5.3: 20 s DynamoDB test timeout (finding 15). FR5.4: the type-only test edit (finding 7). FR5.5: new test groups (findings 1, 2, 3, 6, 14).
- FR6.2, FR7.3: configuration errors exit 2 (finding 14). FR6.3: seed AWS guard (finding 6). FR6.4: the workspace reset command (finding 11). FR6.5 and NFR1: the jar fallback is allowed, and "AWS calls" is defined precisely (finding 10).
- FR7.1 and NFR5: `--source` is required (self-review: the configured default resolves into `packages/backend/data/`).
- FR8.2: KMS wording (finding 9). FR8.4, AC4, AC14: an in-process IaC check replaces the optional `cdk synth` (finding 10).
- NFR3: inconsistency warnings carry ids only (findings 3 and 18). NFR4: thresholds in MB and read units (finding 17).
- AC9, AC11, AC17, AC18, AC19: updated or added to make the above testable.

## Revision 3 changes (requirement level)
- FR4.11, AC20: every item carries `entityType`, including items that an UpdateItem creates and email locks; preferences items carry `userId` (review finding 23). FR4.2's "updates never create items" bullet now names the updates it covers (those that mirror a SQL `UPDATE`), so it no longer contradicts the upsert-style updates of FR4.11.
- AC10: the DynamoDB seed check compares totals with the SQLite smoke test, and the DynamoDB smoke test compares statuses and key sets at every step (self-review: "identical counts" did not say which counts).
- FR4.3: the readiness ping is a strongly consistent read, so every base-table read is (finding 24).
- FR5.3: every opt-in DynamoDB test file uses its own table; no test touches the configured table (finding 27).
- FR5.5, AC7: the route tests and the smoke test replay one fixed 27-step sequence that includes `POST /api/ai/analyze` and `POST /api/chat`, with key sets recorded per step (finding 28).
- FR7.1, AC21: relative `--source` paths resolve against `INIT_CWD` or the working directory, and the script prints the absolute path (finding 26). AC21 also pins the `cli.test.ts` re-import pattern (finding 22).
- NFR5: `.tmp/` is ignored before any runtime file exists, and every run sets `DATABASE_URL` under `.tmp/` (finding 29).
- Finding 25 changes only design wording (§5.5), so no requirement changes for it.
