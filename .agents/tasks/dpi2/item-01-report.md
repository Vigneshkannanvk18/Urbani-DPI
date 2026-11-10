# DPI 2 item 1 report: persistence foundation

- **Status:** DONE (integration pending). Code review verdict: APPROVED, no findings (`item-01/code-review.md`, `item-01/review.json`).
- **Branch / worktree:** `dpi2` in `C:\Antigravity\Urbani DPI\.worktrees\dpi2`. Not pushed, no upstream. `main` unchanged at `5cc5ffa`.
- **dpi2 commit (HEAD):** `4cb8eff86590950e26800e86aa7946a3a26f4fac`
- **Item base commit:** `5c81908`
- **DynamoDB Local was actually exercised:** yes (`amazon/dynamodb-local:2.5.2` on `127.0.0.1:8000`, full suite 340/340 with 0 skipped, seed, migration and HTTP smoke). Container stopped afterwards.

## 1. What was built

- The backend now reaches storage only through async, driver-agnostic repository interfaces (`packages/backend/src/repositories/types.ts`), obtained from `getRepositories()`.
- `DB_DRIVER=sqlite` is the default and keeps DPI 1 behaviour: same SQL, same transactions, same HTTP responses (27 route steps replayed against a baseline captured from the unmodified build).
- `DB_DRIVER=dynamodb` is a new driver covering users (with role) and preferences, audit, alerts with evidence and links, services, environments, logs, metrics, usage, AI analyses, integrations, and chat sessions, messages and feedback.
- Tooling: `npm run dynamo:tables` (DynamoDB Local only), `npm run dynamo:migrate` (SQLite → DynamoDB copy, read-only source, dry-run, idempotent), seed support for DynamoDB, and AWS guards on all of them.
- IaC (authored, not deployed): the `UrbaniApp` table and the least-privilege `UrbaniDashboardTaskRole` in `infra/`, with an offline check (`npm run check` in `infra/`).
- Migration `002_dpi2_persistence_foundation.sql` for SQLite (users.role, preferences, chat tables and the new audit columns).

## 2. Data model chosen and why

Full decision record: [docs/adr/0001-dynamodb-persistence.md](../../../.worktrees/dpi2/docs/adr/0001-dynamodb-persistence.md) (in the dpi2 worktree).

- **One table**, `${DYNAMODB_TABLE_PREFIX}App` (`UrbaniApp` by default): partition key `PK`, sort key `SK` (strings), one overloaded GSI `GSI1` (`GSI1PK`/`GSI1SK`, projection ALL), on-demand billing, the stack's customer-managed KMS key, point-in-time recovery, `RETAIN`.
- Entities read as whole collections use the entity type as partition key (`PK = 'ALERT'`, `SK = <alertId>`), so list reads are strongly consistent base-table Queries. A chat session, its messages and feedback share `CHAT#<sessionId>`. Every item carries `entityType` (needed later by item 6 Streams filtering).
- GSI1 serves audit-by-actor, alert data source, sparse alert links (logs, metrics, analyses linked to an alert) and chat sessions by user.
- Unique email is enforced with a `USER_EMAIL` lock item written in the same transaction as the user.

Why this model:
- DPI 1's SQLite file sits on task-local storage (`host: {}` volume in `deploy-ecs.sh`) and is lost on every task replacement. SQLite is single-writer, so the service cannot run two or more tasks.
- One table instead of about 15: the transactional writes (user + email lock, message + session, feedback + message check) span entity types, the alert cascade needs one GSI query instead of three, and operations (CDK resources, IAM, test tables, migration targets) stay small.
- The existing `UrbaniAlerts` table is not reused. Its key (`service_id`/`timestamp`) cannot serve get-by-alertId, could collide, and belongs to the planned collector/writer Lambda pipeline.
- EFS-backed SQLite was rejected because it is still single-writer.

Accepted divergences from SQLite (secondary UNIQUE constraints, key length, empty ids) and the scale threshold (revisit collection reads at about 1,000 alerts or 3 MB in any entity partition) are documented in ADR §6 and §8.

## 3. Files changed

`git -C "C:\Antigravity\Urbani DPI\.worktrees\dpi2" diff --stat 5c81908..HEAD`: **96 files changed, 11344 insertions(+), 722 deletions(-)**.

Commits (oldest first): `eb6d0f2` chore (ignore `.tmp/`, route baseline), `5842c2b` refactor (async repository layer on SQLite), `86d581a` test (contract suite, route shape, helpers), `23811d0` feat (DynamoDB driver), `5628ec6` feat (DynamoDB Local tooling, opt-in tests, migration), `72b6487` feat(infra) (UrbaniApp table, task role), `4cb8eff` docs (ADR 0001, persistence-driver guide).

```
 .env.example                                       |   46 +-
 .gitignore                                         |    1 +
 docker-compose.yml                                 |   11 +
 docs/adr/0001-dynamodb-persistence.md              |  243 ++++
 infra/README.md                                    |    5 +-
 infra/config/index.ts                              |    7 +
 infra/lib/dashboard-construct.ts                   |   16 +-
 infra/lib/persistence-construct.ts                 |   65 +-
 infra/lib/security-construct.ts                    |   13 +-
 infra/lib/urbani-dpi-stack.ts                      |    4 +-
 infra/package.json                                 |    1 +
 infra/test/app-table.check.ts                      |  164 +++
 infra/tsconfig.json                                |    2 +-
 package-lock.json                                  |  458 +++++-
 package.json                                       |    2 +
 packages/backend/package.json                      |    6 +-
 packages/backend/src/config/index.test.ts          |   47 +
 packages/backend/src/config/index.ts               |   11 +
 packages/backend/src/db/cli.test.ts                |  214 +++
 packages/backend/src/db/cli.ts                     |   67 +
 packages/backend/src/db/cliErrors.ts               |   11 +
 packages/backend/src/db/dynamoTables.ts            |  125 ++
 packages/backend/src/db/migrate.ts                 |    6 +
 .../backend/src/db/migrateSqliteToDynamo.test.ts   |  396 ++++++
 packages/backend/src/db/migrateSqliteToDynamo.ts   |  672 +++++++++
 packages/backend/src/db/migrations.test.ts         |   75 +
 .../migrations/002_dpi2_persistence_foundation.sql |   60 +
 packages/backend/src/db/reset.ts                   |    4 +
 packages/backend/src/db/seed.test.ts               |  107 ++
 packages/backend/src/db/seed.ts                    |  160 +--
 .../src/integrations/mock/MockDynamoDBAdapter.ts   |    8 +-
 packages/backend/src/lib/errors.ts                 |   20 +
 .../src/repositories/alertCorrelation.test.ts      |   63 +-
 .../backend/src/repositories/auditRepository.ts    |   64 -
 packages/backend/src/repositories/common.test.ts   |  285 ++++
 packages/backend/src/repositories/common.ts        |  118 ++
 .../src/repositories/dynamodb/aiRepository.ts      |   75 +
 .../src/repositories/dynamodb/alertRepository.ts   |  241 ++++
 .../src/repositories/dynamodb/auditRepository.ts   |  140 ++
 .../src/repositories/dynamodb/chatRepository.ts    |  348 +++++
 .../backend/src/repositories/dynamodb/client.ts    |   38 +
 .../src/repositories/dynamodb/commands.test.ts     |  635 +++++++++
 .../src/repositories/dynamodb/dynamoOnly.test.ts   |  178 +++
 .../src/repositories/dynamodb/healthRepository.ts  |   22 +
 .../backend/src/repositories/dynamodb/index.ts     |   49 +
 .../repositories/dynamodb/integrationRepository.ts |   28 +
 .../src/repositories/dynamodb/items.test.ts        |  367 +++++
 .../backend/src/repositories/dynamodb/items.ts     |  616 ++++++++
 packages/backend/src/repositories/dynamodb/keys.ts |  140 ++
 .../backend/src/repositories/dynamodb/links.ts     |   69 +
 packages/backend/src/repositories/dynamodb/ops.ts  |  290 ++++
 .../repositories/dynamodb/preferencesRepository.ts |   74 +
 .../src/repositories/dynamodb/tableDefinition.ts   |   35 +
 .../repositories/dynamodb/telemetryRepository.ts   |  282 ++++
 .../src/repositories/dynamodb/userRepository.ts    |  227 +++
 packages/backend/src/repositories/index.test.ts    |   64 +
 packages/backend/src/repositories/index.ts         |   69 +
 .../src/repositories/integrationRepository.ts      |   27 -
 .../src/repositories/repositories.contract.test.ts |   11 +
 .../src/repositories/{ => sqlite}/aiRepository.ts  |   50 +-
 .../repositories/{ => sqlite}/alertRepository.ts   |   98 +-
 .../src/repositories/sqlite/auditRepository.ts     |  116 ++
 .../src/repositories/sqlite/chatRepository.ts      |  280 ++++
 .../src/repositories/sqlite/healthRepository.ts    |   12 +
 packages/backend/src/repositories/sqlite/index.ts  |   50 +
 .../repositories/sqlite/integrationRepository.ts   |   44 +
 .../repositories/sqlite/preferencesRepository.ts   |   81 ++
 .../src/repositories/sqlite/telemetryRepository.ts |  304 ++++
 .../src/repositories/sqlite/userRepository.ts      |   93 ++
 .../src/repositories/telemetryRepository.ts        |  180 ---
 packages/backend/src/repositories/types.ts         |  186 +++
 .../backend/src/repositories/userRepository.ts     |  103 --
 packages/backend/src/repositories/validation.ts    |  282 ++++
 packages/backend/src/routes/apiRoutes.ts           |   26 +-
 packages/backend/src/routes/authRoutes.ts          |    4 +-
 packages/backend/src/routes/healthRoutes.ts        |    6 +-
 packages/backend/src/routes/routes.baseline.json   |  552 ++++++++
 packages/backend/src/routes/routes.test.ts         |  116 ++
 packages/backend/src/server.ts                     |   23 +-
 packages/backend/src/services/aiService.ts         |   22 +-
 packages/backend/src/services/alertService.test.ts |   22 +-
 packages/backend/src/services/alertService.ts      |   37 +-
 packages/backend/src/services/authService.test.ts  |   10 +-
 packages/backend/src/services/authService.ts       |   24 +-
 packages/backend/src/services/chatService.test.ts  |    3 +-
 packages/backend/src/services/chatService.ts       |   24 +-
 packages/backend/src/services/dashboardService.ts  |   28 +-
 packages/backend/src/services/settingsService.ts   |   13 +-
 packages/backend/src/services/telemetryService.ts  |   21 +-
 packages/backend/src/services/usageService.ts      |   12 +-
 packages/backend/src/test/keySet.ts                |   31 +
 packages/backend/src/test/repositoryContract.ts    | 1481 ++++++++++++++++++++
 packages/backend/src/test/repositoryHarness.ts     |  130 ++
 packages/backend/src/test/setup.ts                 |    1 +
 packages/backend/src/test/testDb.ts                |    7 +-
 packages/shared/src/domain.ts                      |   12 +
 96 files changed, 11344 insertions(+), 722 deletions(-)
```

`packages/frontend`, `deploy-ecs.sh` and `redeploy.sh` have no diff.

## 4. Tests added and updated

Totals: **340 tests in 23 files**. Before this item: 73 tests in 11 files. New: **267 tests** (187 in the default suite, 80 DynamoDB opt-in tests that run only when `DYNAMODB_ENDPOINT` is set).

**Added test files (12)**, with default-suite passed / opt-in counts:

| File | Default passed | Opt-in (DynamoDB Local) |
|---|---|---|
| repositories/repositories.contract.test.ts | 69 (`[sqlite]`) | 69 (`[dynamodb]`) |
| routes/routes.test.ts | 27 | – |
| repositories/dynamodb/commands.test.ts | 26 | – |
| db/cli.test.ts | 19 | – |
| repositories/common.test.ts | 17 | – |
| repositories/dynamodb/items.test.ts | 9 | – |
| db/seed.test.ts | 6 | 2 |
| config/index.test.ts | 5 | – |
| repositories/index.test.ts | 4 | – |
| db/migrateSqliteToDynamo.test.ts | 3 | 6 |
| db/migrations.test.ts | 2 | – |
| repositories/dynamodb/dynamoOnly.test.ts | 0 | 3 |
| **Total** | **187** | **80** |

New test support modules: `src/test/repositoryContract.ts` (the 69 `C-` cases, shared by both drivers), `src/test/repositoryHarness.ts`, `src/test/keySet.ts`; plus the committed fixture `src/routes/routes.baseline.json`. `src/test/setup.ts` and `src/test/testDb.ts` were adjusted.

**Updated pre-existing test files (4)**, all 73 pre-existing tests still pass with unchanged per-file counts and no assertion removed or weakened:
- `repositories/alertCorrelation.test.ts` (5 tests): async/await and registry access.
- `services/alertService.test.ts` (12 tests): async/await, registry access, plus the FR5.4 type-only edit.
- `services/authService.test.ts` (4 tests): await `upsertRole`/`upsertUser`, plus the FR5.4 type-only edit.
- `services/chatService.test.ts` (1 test): only the FR5.4 type-only edit.

### FR5.4 type-only test edit

FR5.4 limits edits to existing tests to async/await, registry access, and one named type-only edit. That edit was applied to `services/alertService.test.ts`, `services/authService.test.ts` and `services/chatService.test.ts`: each file deletes `import type Database from 'better-sqlite3'` and declares `let db: ReturnType<typeof freshTestDb>;` instead of `let db: Database.Database;`. `freshTestDb()` returns `Database.Database`, so the type is identical and no assertion changes. Without it, the AC5 import gate (no `better-sqlite3` imports outside `repositories/`, `db/` and `test/`) fails on these three files. `routes/routes.test.ts` was written the same way from the start.

## 5. Verification results (from `item-01/verification.md`)

Run on HEAD `4cb8eff86590950e26800e86aa7946a3a26f4fac`, 2026-11-06, PowerShell 5.1, Node v24.13.0. Every V-step met its expectation; no seam fix was needed.

| Step | Command / check | Result |
|---|---|---|
| V1 Build | `npm run build` (root) | exit 0 (shared, backend incl. migrations copy, frontend). Pre-existing vite chunk-size warning only |
| V2 Default tests | `npm test`, `DYNAMODB_ENDPOINT` unset | exit 0. Test Files 22 passed, 1 skipped (23). Tests 260 passed, 80 skipped (340). The 80 skipped are the DynamoDB opt-in blocks (contract 69, dynamoOnly 3, seed 2, migrate 6). The 73 pre-existing tests pass unchanged |
| V3 Static gates | AC5 imports, AC19 Query/Batch commands only in `ops.ts`, AC18 no `RegExp` under `repositories/`, AC6 no un-awaited `repos.` calls, no frontend diff | all empty / clean |
| V4 Frontend | `npx tsc -b --noEmit` in `packages/frontend` | exit 0 |
| V5 Infra (no CDK CLI) | `npm ci; npx tsc --noEmit; npm run check` in `infra/` | 0 / 0 / 0. `app-table check passed: UrbaniApp table (PK/SK, GSI1, CMK, PITR, Retain), UrbaniAlerts unchanged, UrbaniDashboardTaskRole (ecs-tasks + aws:SourceAccount, 2 statements, no Scan), backend DB_DRIVER=sqlite`. `npm ci` reports 3 pre-existing lockfile vulnerabilities (2 moderate, 1 high); lockfile not changed |
| V6 SQLite smoke, port 4100 | seed + 27 HTTP steps vs. baseline | exit 0. Migrations 001 and 002 applied, `Persistence driver: sqlite`, `Baseline comparison: all 27 steps match` (404 at steps 09 and 14 as expected). Port 4100 freed |
| V7 AWS pre-flight | `~/.aws/credentials` or `config` present? `AWS_*` vars? | `False`, no variables. No AWS call possible |
| V8 DynamoDB Local | Docker 29.8.0, `amazon/dynamodb-local:2.5.2` on `127.0.0.1:8000` | **exercised**, see below |
| V9 Guards | AWS-target refusals | `dynamo:tables` without endpoint → 2; `dynamo:migrate` without endpoint/`--allow-aws` → 2; `DYNAMODB_ENDPOINT=ftp://x` → 2; `DB_DRIVER=dynamodb npm run seed` → 2; `reset` on DynamoDB → 1. Expected messages; tripwire file absent |
| V10 Hygiene | git status, ports, branch, main | worktree clean; `.gitignore` diff is only `+.tmp/`; ports 4100/8000 free, no container, no node process; `main` = `5cc5ffa05d41f47c61dc6d5c423bda51cc11b188`; branch `dpi2`, no upstream |

**V8 DynamoDB Local details (actually exercised):**
1. `$env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm test` → exit 0: **Test Files 23 passed (23), Tests 340 passed (340), 0 skipped**, 47.08 s. Contract suite 138 = 69 `[sqlite]` + 69 `[dynamodb]`, all passed; `dynamoOnly` 3/3, `migrateSqliteToDynamo` 9/9, `seed` 8/8.
2. `npm run dynamo:tables` → `UrbaniSmokeApp ... created`. `npm run seed` twice → exit 0 both, `Persistence driver: dynamodb` (endpoint `http://127.0.0.1:8000`), second run `Admin user already exists; skipping`.
3. `npm run dynamo:migrate` from the SQLite smoke DB into `UrbaniMigrateApp`: dry run twice → 115 would-create, 0 skip, 0 failed; real run → 115 created; re-run → 0 created, 115 skipped, 0 failed.
4. HTTP smoke on DynamoDB, port 4100 → exit 0, `Baseline comparison: all 27 steps match`. Totals SQLite / DynamoDB: alerts 3 / 3, services 4 / 4, usage 7 / 7. 15 of 27 bodies byte-identical; the rest differ only in generated ids and timestamps, and in steps 06 and 11 in the order of metric snapshots with equal timestamps (an accepted, documented divergence; the set of lines is the same).
5. `docker stop urbani-dynamodb-local` → exit 0; no container left; port 8000 refused connections.

Noted, outside this item: the main workspace `.gitignore` shows ` M` because another actor removed its `.env` line on 2026-11-05. This workflow did not touch it. **The user should confirm whether that is intended**; without the rule a `.env` with secrets could be committed on `main`.

## 6. Follow-ups

- **Item 2: the create-user path must require an explicit role.** Migration 002 keeps `DEFAULT 'SUPER_ADMIN'` on `users.role` so existing DPI 1 users become Super Admin (FR3.1), and the DynamoDB repository applies the same default. Any insert that forgets the role therefore creates a Super Admin. Item 2 must make the role mandatory on create-user, and can then drop the column default with a migration. Item 2 also adds `users.list()` and must revisit the check-then-write in `createSession` if it adds user deletion.
- **Stale tracked SQLite sidecar files, flagged for a separate cleanup.** These files are tracked in git (listed with `git ls-files` only; not opened and not modified in this item):
  - `packages/backend/data/urbani.sqlite-shm`
  - `packages/backend/data/urbani.sqlite-wal`
  - `packages/backend/data/verify.sqlite-shm`
  - `packages/backend/data/verify.sqlite-wal`

  They are runtime WAL/shared-memory files and should be removed from the index (`git rm --cached`) and ignored, in a separate, explicitly approved change.
- **Settings audit size on DynamoDB** (code-review note 3): `PUT /api/settings` audits `Object.keys(req.body)`. A body whose keys serialize to more than 380 KiB gets `ITEM_TOO_LARGE` (HTTP 500) on DynamoDB, where SQLite stores the event. Follows the approved size policy; add to the item 14 go-live checklist.
- **Scale threshold:** revisit collection-read patterns at about 1,000 alerts or 3 MB in any entity partition (ADR §8). Item 3 adds audit cursors and retention/TTL.

## 7. To go LIVE

Nothing below has been executed. No AWS call, CDK synth/deploy or deploy script was run in this item.

### 7.1 What the client / AWS side must provide

1. **AWS account id and region.** The region must equal the ECS service region, `us-east-1` in the current `deploy-ecs.sh`.
2. **Permission to create one DynamoDB table and one IAM policy** (or the role attachment) in that account.
3. **Credentials for an operator host** in the target account, used once to run the data migration (step 7.5).
4. **ECS Exec access** to the running DPI 1 task (to copy the SQLite file out). This needs `ssmmessages:*` on the task role; whether the current `dpi-task-policy` grants it is UNVERIFIED.
5. **Approval to deploy** (item 14) and a decision on the table prefix if not `Urbani`.

### 7.2 Create the table (IaC)

- **CDK path:** deploy the `PersistenceConstruct` app table (`infra/lib/persistence-construct.ts`) with `cdk deploy -c account=<ACCOUNT_ID> -c region=<REGION>`. Item 14 decides whether that is the full stack or a persistence-only stack.
- **Or create an identical table** named `UrbaniApp` (`<prefix>App`): `PK` (S) / `SK` (S), GSI `GSI1` on `GSI1PK` (S) / `GSI1SK` (S) with projection ALL, on-demand billing, PITR on, deletion protection recommended (the CDK table also uses the stack's customer-managed KMS key and `RETAIN`).

### 7.3 Task-role permissions

- **CDK path:** `grantAppDataAccess` already gives `UrbaniDashboardTaskRole` exactly the two statements below (checked offline by `npm run check` in `infra/`).
- **Deploy-script path** (`urbaniqa-dpi-task-role` created by `deploy-ecs.sh`): attach this policy (design Appendix A). Replace the placeholders. Include the second statement only if the table uses a customer-managed key.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UrbaniAppTableData",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:PutItem",
                 "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"],
      "Resource": ["arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/UrbaniApp",
                   "arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/UrbaniApp/index/GSI1"]
    },
    {
      "Sid": "UrbaniAppTableKmsViaDynamoDb",
      "Effect": "Allow",
      "Action": ["kms:Decrypt", "kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"],
      "Resource": "<CMK_ARN>",
      "Condition": { "StringEquals": { "kms:ViaService": "dynamodb.<REGION>.amazonaws.com" } }
    }
  ]
}
```

No Scan, DescribeTable, admin or Streams permissions are needed. Whether `kms:DescribeKey` is needed at runtime is unverified; add it only if testing shows `AccessDenied`.

### 7.4 Task environment variables (item 14 edits `deploy-ecs.sh`)

| Variable | Value |
|---|---|
| `DB_DRIVER` | `dynamodb` |
| `DYNAMODB_TABLE_PREFIX` | `Urbani` (or the agreed prefix; table name is `<prefix>App`) |
| `AWS_REGION` | `<REGION>` |
| `DYNAMODB_ENDPOINT` | **not set** (it is only for DynamoDB Local) |

After the switch, `DATABASE_URL` and the `/data` volume can be removed, and `desiredCount` can be raised to 2 or more across 2 AZs. Credentials come from the ECS task role; none go into code or env files.

### 7.5 Run the migration

The DPI 1 database lives on task-local storage (`host: {}` volume), so any redeploy loses it. Copy it out first.
1. Through ECS Exec (service created with `--enable-execute-command`), checkpoint the WAL: `node -e "const D=require('better-sqlite3');const d=new D('/data/urbani.sqlite');d.pragma('wal_checkpoint(TRUNCATE)');d.close()"`.
2. Copy the file out (for example base64-streamed through the session) and keep it as the DPI 1 backup. Take it **before the first DPI 2 image starts on that SQLite file**: a DPI 2 start applies migration 002 automatically and 002 is forward-only.
3. From a dpi2 build on the operator host, with credentials for the target account: `npm run dynamo:migrate -- --source <absolute path of the copy> --dry-run --allow-aws` (or `node packages/backend/dist/db/cli.js migrate --source <absolute path> --dry-run --allow-aws`). Check the printed `Source (read-only):` line. Do not seed the target table before migrating.
4. Run again without `--dry-run` and verify the counts. Exit code 0 means no failures.
5. Deploy with `DB_DRIVER=dynamodb`. Re-running the migration is safe; it only adds missing rows.

If the file cannot be copied, start fresh: run the seed once in the new task, `FORCE_DB_SEED=yes node packages/backend/dist/db/seed.js --allow-aws`. That recreates the admin and MOCK reference data. LIVE alerts re-sync from the Urbani API, but their acknowledgements and the DPI 1 audit and AI-analysis history are lost.

Rollback: setting `DB_DRIVER=sqlite` again does not copy DynamoDB data back.

### 7.6 Go / no-go

- The DynamoDB contract suite has passed on DynamoDB Local: **done in this item** (69/69 `[dynamodb]`, 340/340 overall).
- `/ready` returns 200 in the new task.
- Login works.
- The DPI 1 admin password has been rotated (DPI 2 plan §6.5).
