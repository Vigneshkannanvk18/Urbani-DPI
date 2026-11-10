# Implementation Plan — DPI 2 item 1: Persistence foundation

**Inputs** (all in `C:/Antigravity/Urbani DPI/.agents/tasks/dpi2/item-01/`): `requirements.md` Rev 3, `design.md` Rev 3 (APPROVED), `design-review.md`, `design-verdict.json`, `baseline.md`. "§n" means a section of `design.md`; "FRn"/"ACn" means `requirements.md`. This plan sequences the approved design. It changes no interface, key schema or acceptance criterion.

**Folded-in adjustments.** The five LOW findings that were approved with the design, plus one planner note:
- **[F30]** Every runtime environment set pins `LOG_LEVEL=info`. This host exports `LOG_LEVEL=error` at process scope, and that hides the info lines the checks read.
- **[F31]** Run the AWS-credential pre-flight (V7) before any DynamoDB-mode command and before the guards. Never open `~/.aws/sso/cache/*`.
- **[F32]** `dynamo:migrate` precondition 6 (the `health.ping` of the target):
  - a fatal `PersistenceError` exits 2 with `create the table first (npm run dynamo:tables)`, or with the access hint;
  - a non-fatal `UNAVAILABLE` exits 1 with `DynamoDB not reachable at <endpoint>`.
  Add both rows to the error-handling behaviour.
- **[F33]** Quoting and the migrate refusal:
  - Quote every `<wt>` path.
  - The precondition-4 refusal text is exactly `Refusing: dynamo:migrate would target AWS DynamoDB. Pass --allow-aws, or set DYNAMODB_ENDPOINT for DynamoDB Local.`
  - `parseMigrateArgs` rejects any token that is neither a known flag nor the `--source` value (usage error, exit 2).
  - `cli.test.ts` asserts the refusal text through a `process.stderr.write` spy.
  - Guard V9 checks the text as well as the exit code.
- **[F34]** The key guard is `1 ≤ UTF-8 bytes ≤ limit` for every key part, in `keys.fitsKey` and in every `items.ts` builder. The limits are 2,048 bytes for PK/GSI1PK and 1,024 bytes for SK/GSI1SK.
  - An empty-id lookup returns not-found without a call. An empty-key write raises `INVALID_ARGUMENT`.
  - C-KY-01 also looks up `''`, except `audit.query({ actor: '' })`, because an empty actor means "no filter".
  - `items.test.ts` gets an empty-id case.
  - ADR §7 lists "empty ids" next to "Key length", with the consequence: an upstream alert without an id aborts the DynamoDB live sync at that alert.
- **[P1]** `createDynamoContext` passes `throwOnRequestTimeout: true` in `requestHandler`, next to `connectionTimeout: 2_000, requestTimeout: 5_000`. Current `@smithy/node-http-handler` only logs a warning when `requestTimeout` is exceeded unless this flag is set, so without it the §5.10 `TimeoutError → UNAVAILABLE` row never fires ([NodeHttpHandlerOptions](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-smithy-node-http-handler/Interface/NodeHttpHandlerOptions)).

**Execution shape.** Items 1–13 are grouped into five sequential features. The FEAT files are in `C:/Antigravity/Urbani DPI/.agents/tasks/dpi2/item-01/task-dpi2-item01-persistence/`, and `context.json` there summarises this section 0.
- FEAT-001: items 1–5. FEAT-002: item 6. FEAT-003: items 7–8. FEAT-004: items 9–11. FEAT-005: items 12–13.
- Item 14 is the cross-feature verification. Item 15 is the report.

Every item leaves `npm run build` and the 73 pre-existing tests green.

---

## 0. Conventions (every item)

- `<wt>` = `C:\Antigravity\Urbani DPI\.worktrees\dpi2` (branch `dpi2`, base `5c81908`). It contains a space, so quote it everywhere. Start every PowerShell call with `Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2"`. A relative path in any file tool resolves into the main workspace `C:\Antigravity\Urbani DPI`, which must stay untouched. `main` = `5cc5ffa`; never change it.
- Never open or modify `<wt>\packages\backend\data\*` (tracked stale WAL/SHM files) or `C:\Antigravity\Urbani DPI\packages\backend\data\*`. Runtime databases live only under `<wt>\.tmp\`, which item 1 ignores.
- No AWS:
  - no AWS CLI or SDK call against AWS;
  - no CDK CLI (`cdk synth`, `cdk deploy`, …);
  - never run `deploy-ecs.sh` or `redeploy.sh`.
  DynamoDB means DynamoDB Local on `127.0.0.1:8000` only. Anonymous npm and Docker Hub downloads are allowed.
- Ports: 4100 for the API, 8000 for DynamoDB Local. Stop everything you start.
- **Process lifetime (verified while planning):** the shell tool kills child processes when a call returns. A server started with `Start-Process` in one call is gone in the next call. Each smoke run therefore starts, uses and stops the server in **one** call, through `smoke.ps1` (item 1). DynamoDB Local runs in the Docker daemon, so it survives across calls and must be stopped with `docker stop`.
- Exit codes: read `$LASTEXITCODE`. Windows PowerShell shows npm/vite stderr lines as `NativeCommandError` records; that is cosmetic.
- Commits:
  - Commit on `dpi2` with Conventional Commits. Stage by path (`git add -- <paths>`).
  - Before each commit, `git -C "<wt>" status --short` must show nothing staged under `.tmp/` or `packages/backend/data/`, and no `.env`.
  - Never push, merge, rebase or fast-forward. Keep the worktree.
- If the only way to satisfy a requirement or a review finding changes what the user sees or how the system behaves, stop and ask (`send_message` severity `warning`).

### Environment sets [F30]
These sets override inherited values.

- **ENV-SQLITE(`<db>`)**
  ```powershell
  $wt='C:\Antigravity\Urbani DPI\.worktrees\dpi2'; Set-Location $wt; Remove-Item Env:DYNAMODB_ENDPOINT, Env:DYNAMODB_TABLE_PREFIX -ErrorAction SilentlyContinue; $env:JWT_SECRET='dev'; $env:NODE_ENV='development'; $env:LOG_LEVEL='info'; $env:INTEGRATION_MODE='mock'; $env:DB_DRIVER='sqlite'; $env:DATABASE_URL="$wt\.tmp\smoke\<db>\urbani.sqlite"
  ```
- **ENV-DYNAMO(`<prefix>`)**
  ```powershell
  $wt='C:\Antigravity\Urbani DPI\.worktrees\dpi2'; Set-Location $wt; $env:JWT_SECRET='dev'; $env:NODE_ENV='development'; $env:LOG_LEVEL='info'; $env:INTEGRATION_MODE='mock'; $env:DB_DRIVER='dynamodb'; $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; $env:DYNAMODB_TABLE_PREFIX='<prefix>'; $env:DATABASE_URL="$wt\.tmp\smoke\dynamo-unused\urbani.sqlite"
  ```
  The `DATABASE_URL` here is a tripwire: that file must never exist.
- **ENV-GUARD**
  ```powershell
  $wt='C:\Antigravity\Urbani DPI\.worktrees\dpi2'; Set-Location $wt; Remove-Item Env:DYNAMODB_ENDPOINT, Env:DB_DRIVER, Env:DYNAMODB_TABLE_PREFIX -ErrorAction SilentlyContinue; $env:JWT_SECRET='dev'; $env:NODE_ENV='development'; $env:LOG_LEVEL='info'; $env:DATABASE_URL="$wt\.tmp\smoke\guard\unused.sqlite"
  ```

The worktree has no `.env`, verified, so `dotenv` adds nothing. The seed admin is the config default, `admin@urbani.local` / `ChangeMe123!`.

---

## FEAT-001 — Async, driver-agnostic repository layer on SQLite (items 1–5)

- [ ] **1. Hygiene, smoke tooling and baseline capture (before any source change).**
  1. Append `.tmp/` as a new last line of `<wt>\.gitignore`, after `.worktrees/` (line 42). Prove the rule with a probe file:
     ```powershell
     Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2"; New-Item -ItemType Directory -Force .tmp\smoke | Out-Null; New-Item -ItemType File -Force .tmp\smoke\probe.sqlite-wal | Out-Null; git check-ignore -v .tmp/smoke/probe.sqlite-wal; git status --short; Remove-Item .tmp\smoke\probe.sqlite-wal
     ```
     Expected: `check-ignore` names the `.gitignore:43:.tmp/` rule, and `status` lists only ` M .gitignore`.
  2. Write `<wt>\.tmp\smoke\capture.mjs`. It is throwaway, ignored and never committed, and needs Node ≥ 18 with no dependencies.
     - Usage: `node capture.mjs <baseUrl> <outDir> [<baselineKeysets.json>]`.
     - It replays the 27-step table of §14 step 1 exactly: the step ids, order, bodies and expected statuses.
     - Login uses `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, defaulting to `admin@urbani.local`/`ChangeMe123!`. From step 04 on it sends `Authorization: Bearer <token>`.
     - It carries three values between steps: `token` = 03 `body.token`, `A` = 07 `body.data.items[0].alertId`, `N` = 20 `body.data.id`.
     - For each step it writes `<outDir>\<stepId>.json` (the pretty-printed body) and records `{ status, keys }`. `keys` comes from the §14 key-set algorithm:
       - an object adds `parent.key` and recurses;
       - an array recurses under `parent[]`, and a primitive element adds `parent[]`;
       - a primitive or `null` adds nothing;
       - the result is sorted and distinct.
     - It writes `<outDir>\keysets.json` as `{ "<stepId>": { "status": n, "keys": [...] } }`, in step order and without values.
     - It exits 1 when any status differs from the table, or when the `02-get-ready` body is not exactly `{"status":"ready","checks":{"database":"ok"}}`.
     - With a baseline argument, it compares each step's `status` and `keys` with the baseline and prints every mismatch: step id, missing keys, extra keys. It exits 1 on any mismatch and 0 otherwise.
  3. Write `<wt>\.tmp\smoke\smoke.ps1`, also throwaway.
     - Parameters:
       - `-Driver sqlite|dynamodb` (mandatory) and `-Name <folder under .tmp\smoke>` (mandatory);
       - `-Prefix <DYNAMODB_TABLE_PREFIX>`, default `UrbaniSmoke`;
       - `-Seed` (sqlite only). It first deletes `$dir\urbani.sqlite`, `urbani.sqlite-wal` and `urbani.sqlite-shm` if present, so every run starts from a freshly seeded database; a reused database fails steps 18 and 19, which expect no analyses and no metadata yet. It then runs `node packages/backend/dist/db/seed.js` with the same environment and fails on a non-zero exit;
       - `-Baseline <path>` (optional);
       - `-CheckDriverLine` (switch).
     - It sets ENV-SQLITE(`<Name>`) or ENV-DYNAMO(`<Prefix>`), plus `PORT=4100`, and refuses to run if port 4100 is already listening.
     - It starts the server with `Start-Process -FilePath node -ArgumentList 'packages/backend/dist/server.js' -WorkingDirectory $wt -WindowStyle Hidden -PassThru -RedirectStandardOutput "$dir\server.out.log" -RedirectStandardError "$dir\server.err.log"`, then waits up to 30 s for `server.out.log` to contain `Urbani Observability API listening`.
     - With `-CheckDriverLine`, before any request:
       - sqlite: the `Persistence driver: sqlite` line must contain `smoke` and `<Name>`;
       - dynamodb: the line must contain `"endpoint":"http://127.0.0.1:8000"`;
       - otherwise it stops the server and exits 3.
     - It runs `node "$wt\.tmp\smoke\capture.mjs" http://127.0.0.1:4100 "$dir" [<Baseline>]`, always stops the server with `Stop-Process`, confirms port 4100 is free, and exits with the capture's exit code.
  4. `npm run build` at `<wt>`, on the unmodified sources.
  5. Capture the baseline:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\smoke.ps1" -Driver sqlite -Name baseline -Seed
     ```
     Do not pass `-CheckDriverLine`: the old build does not log that line.
  6. `Copy-Item "<wt>\.tmp\smoke\baseline\keysets.json" "<wt>\packages\backend\src\routes\routes.baseline.json"`. This is the committed fixture, with no values in it.

  Files: `<wt>\.gitignore`, `<wt>\packages\backend\src\routes\routes.baseline.json` (new); throwaway `<wt>\.tmp\smoke\capture.mjs` and `<wt>\.tmp\smoke\smoke.ps1`.
  Verify: the probe output above. The baseline run exits 0. `keysets.json` has 27 entries, and its statuses match the §14 table: 200 everywhere except 404 at steps 09 and 14.

- [ ] **2. Shared enums, `PersistenceError`, config.**
  - `<wt>\packages\shared\src\domain.ts`: insert the five `as const` arrays and their types from §3.2 (`USER_ROLES`, `AUDIT_RESULTS`, `THEMES`, `CHAT_MESSAGE_ROLES`, `CHAT_RATINGS`) after `interface AuditEvent` (lines 86–94), before `dashboardSummarySchema` (line 95). `AuditEvent` is unchanged.
  - `<wt>\packages\backend\src\lib\errors.ts`: append `PersistenceReason`, `PERSISTENCE_STATUS` and `class PersistenceError extends AppError` verbatim from §7.1, after `ServiceUnavailableError` (lines 63–67).
  - `<wt>\packages\backend\src\config\index.ts`:
    - add `DYNAMODB_TABLE_PREFIX` and `DYNAMODB_ENDPOINT` (the §6 code) after `DYNAMODB_GSI_ANOMALY_TYPE` (line 85);
    - add `dynamodb: { tableName: \`${env.DYNAMODB_TABLE_PREFIX}App\`, endpoint: env.DYNAMODB_ENDPOINT ?? null }` inside `db: {…}` (lines 173–176);
    - leave `config.dynamodb` (lines 220–223) unchanged.

  Verify: `npm run build --workspace @urbani/shared; npm run build --workspace @urbani/backend; npm test` exit 0, 73/73 passing.

- [ ] **3. Repository core modules (compile standalone; not wired yet).**
  - `<wt>\packages\backend\src\repositories\types.ts`: the §3.2 code block verbatim. It holds every entity interface plus `Repositories`, `RepositoryOptions`, `PageResult`, `CursorPage` and `CursorOptions`.
  - `<wt>\packages\backend\src\repositories\common.ts` (§4.5):
    - `clampPage(page, pageSize, defaultSize) → { page, pageSize, offset }`, using `Math.max(page ?? 1, 1)` and `Math.min(Math.max(pageSize ?? def, 1), 200)`;
    - `compareBinary(a, b)`, which is `Buffer.compare` on UTF-8;
    - `compileLike`, verbatim from §4.5, and `likeContains`;
    - `encodeCursor(parts)` and `decodeCursor(cursor, schema)`: base64url JSON `{ v: 1, k }`, at most 1,024 characters; any failure throws `PersistenceError('INVALID_CURSOR', 'Invalid cursor')`;
    - `newTimeOrderedId(nowIso)`: 13-digit epoch ms, `-`, then `randomUUID()`, strictly increasing within the process;
    - `buildAuthUser(user, role)`: the body of today's `toAuthUser` (`userRepository.ts` lines 64–80), with the `UNKNOWN`/`[]` fallbacks.
  - `<wt>\packages\backend\src\repositories\validation.ts`: zod schemas for every row of the §7.3 table.
    - Each `parse*` helper throws `PersistenceError('INVALID_ARGUMENT', 'Invalid argument', { details: issues })`.
    - Exports: `parseUserRole(role?)` (returns `UserRole | null`), `parseAuditResult(result?)` (defaults to `'SUCCESS'`), `parseAuditRangeQuery(opts)` (normalised ISO `from`/`to`, `from <= to`, limit 1..200 with default 50), `parsePreferencesPatch(userId, patch)`, `parseNewChatSession`, `parseNewChatMessage`, `parseChatFeedbackInput`, `parseReadId(id)` (1–128 characters), and the chat limit clamps (sessions 1..100 default 20, messages 1..500 default 200).
    - Cursor tuple schemas: `auditCursorSchema(from?, to?)` (canonical `ts`, `id` 1–64 characters, `from <= ts <= to` under `compareBinary`), `sessionCursorSchema` (canonical `updatedAt`, id `^[A-Za-z0-9_-]{1,128}$`) and `messageCursorSchema` (`[id]`).
  - `<wt>\packages\backend\src\db\cliErrors.ts`: `export class CliPreconditionError extends Error` with `name = 'CliPreconditionError'`. It has no imports (§9.5).

  Verify: `npm run build --workspace @urbani/backend` exit 0; `npm test` 73/73. The tests for these modules come in item 6.

- [ ] **4. Migration 002 and its test.** The test keeps the existing suite green, because DPI 1 code names its INSERT columns.
  - `<wt>\packages\backend\src\db\migrations\002_dpi2_persistence_foundation.sql`: the §4.4 SQL verbatim. `scripts/copy-assets.js` already copies every `*.sql` into `dist`, so it needs no change.
  - `<wt>\packages\backend\src\db\migrations.test.ts`, following the §8.3 row:
    - Build a 001-only database: exec `001_initial_schema.sql`, create `schema_migrations` (`version TEXT PRIMARY KEY, applied_at TEXT NOT NULL`) and insert `001_initial_schema`.
    - Insert 1 role, 1 user and 3 audit rows: `{"outcome":"unavailable"}`, other JSON, and NULL.
    - Assert that `runMigrations(db)` returns `['002_dpi2_persistence_foundation']`. Then check: role `SUPER_ADMIN`; results `FAILURE`, `SUCCESS`, `SUCCESS`; the 4 new tables exist in `sqlite_master`.
    - A second `runMigrations(db)` returns `[]`.
    - `UPDATE users SET role='BOGUS'` throws.

  Verify: `npm test` exit 0, with 73 passing plus the new migration test(s).

- [ ] **5. SQLite driver, registry, all callers, seed, test helpers and existing tests, as one atomic change.** The `git mv` breaks every import until all callers are converted, so this is one item.
  1. Move the six repository files:
     ```powershell
     Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2\packages\backend\src\repositories"; New-Item -ItemType Directory -Force sqlite | Out-Null; foreach ($f in 'alertRepository.ts','telemetryRepository.ts','userRepository.ts','aiRepository.ts','auditRepository.ts','integrationRepository.ts') { git mv $f "sqlite/$f" }
     ```
  2. Convert each moved file into a factory that returns its §3.2 interface (§4.1).
     - Methods are closures over local functions, not object literals that use `this`.
     - Every method is `async`, with its SQL and its `db.transaction` bodies kept verbatim and **no internal `await`** (§2.4). Use sync local helpers, such as `findByIdSync` in alerts and `getRoleSync` in users, where one method calls another.
     - `getDb()` is called per method, as today, so `setDbForTesting` keeps working.
     - Every `new Date().toISOString()` becomes `ctx.now()`.
     - Delete the interface declarations that moved to `types.ts`, and import them from `../types`.

     Per file:
     - `sqlite/alertRepository.ts` → `sqliteAlertRepository(ctx)`. It has the 9 existing methods (insert 93, upsertLivePreservingStatus 141, findById 198, query 205, replaceDerivedEvidence 244, deleteByDataSource 261, acknowledge 266, countActive 277, countBySeverity 285) plus `countAll` (`SELECT COUNT(*) AS c FROM alerts`).
     - `sqlite/telemetryRepository.ts` → five factories:
       - `sqliteServiceRepository`: `all`, `findById`, `count`, plus `upsert(service, source)` with the §4.2 `INSERT OR REPLACE` and `created_at = ctx.now()`;
       - `sqliteEnvironmentRepository` (new): `ensure` with `INSERT OR IGNORE` and `created_at = ctx.now()`, and `all` ordered by name;
       - `sqliteLogRepository`: `query`, `byAlert`, `clearAlertLinks`, `linkLogsToAlert`, plus `upsertMany`;
       - `sqliteMetricRepository`: `query`, plus `upsertMany`;
       - `sqliteUsageRepository`: `all`, plus `upsertMany`.
       Each `upsertMany` runs the seed's statement inside one `db.transaction`, with `data_source = source`: logs `seed.ts` 105–110, metrics 113–134, usage 137–152. `services.upsert` takes the statement at 81–97, and `environments.ensure` the one at 76–78.
     - `sqlite/userRepository.ts` → `sqliteUserRepository(ctx)`.
       - `findByEmail`, `findById` and `getRole` keep their SQL; rows now include `role`.
       - `toAuthUser` is `buildAuthUser(user, getRoleSync(user.role_id))`.
       - `recordLogin` uses `ctx.now()`. `upsertRole` is unchanged.
       - `upsertUser(row: UserUpsert)` uses the §4.3 `INSERT … ON CONFLICT(id) DO UPDATE` SQL with `@role = parseUserRole(row.role)`.
     - `sqlite/aiRepository.ts` → `sqliteAIAnalysisRepository(ctx)`, with `created_at = ctx.now()`.
     - `sqlite/auditRepository.ts` → `sqliteAuditRepository(ctx)`.
       - `record(actor, action, target?, metadata?, result?)` validates `result` through `parseAuditResult` and adds the `result` column to the INSERT. `timestamp` and `created_at` come from `ctx.now()`.
       - `query` keeps its SQL and the `rowTo` mapper, which never emits `result`.
       - `listByTimeRange` runs the §4.5 keyset SQL, decodes the cursor with `auditCursorSchema(from, to)` before querying, fetches `limit + 1` rows, and sets `nextCursor` from item `n-1` only when `n+1` rows came back.
     - `sqlite/integrationRepository.ts` → `sqliteIntegrationRepository(ctx)`: `all`, plus `upsert` (`INSERT OR REPLACE`) and `delete` (`DELETE FROM integrations WHERE id = ?`).
  3. New SQLite files (§4.5):
     - `sqlite/preferencesRepository.ts`: `get` and `update`, with the user-exists check, merge, `ON CONFLICT(user_id) DO UPDATE` and `userId` in the result.
     - `sqlite/chatRepository.ts`: `createSession`, `getSession`, `listSessionsByUser`, `appendMessage`, `listMessages`, `setFeedback` and `listFeedback`. Each validates first and runs its checks and writes in one synchronous transaction. The keyset lists follow §4.5.
     - `sqlite/healthRepository.ts`: `ping` = `getDb().prepare('SELECT 1').get()`.
     - `sqlite/index.ts`: `export interface SqliteContext { now: () => string }` and `createSqliteRepositories(opts?: RepositoryOptions): Repositories`. It wires all 13 repositories, sets `driver: 'sqlite'` and `close: async () => closeDb()`. The repository files import `SqliteContext` with `import type`.
  4. `<wt>\packages\backend\src\repositories\index.ts`: the §3.3 registry.
     - It exports `getRepositories`, `setRepositoriesForTesting`, `resetRepositories` and `assertDynamoReachable`, plus `export * from './types'`.
     - **Until FEAT-003**, the `dynamodb` branch of `build()` throws `new PersistenceError('UNAVAILABLE', 'DB_DRIVER=dynamodb: the DynamoDB driver is not part of this build yet', { fatal: true })`. FEAT-003 replaces it with the §3.3 branch.
  5. Convert the callers (§3.4). Use `const repos = getRepositories();` inside each function, not at module scope and not destructured, and `await` every call. Imports come from `'../repositories'`.
     - `services/alertService.ts`:
       - lines 2–4 become the registry import;
       - `syncLiveAlerts` (115, 118 inside the sequential loop) and `correlateLiveAlerts` (166, 170, 171 inside the existing per-alert try) await their calls;
       - `list` (194), `get` (213, 215, 220) and `acknowledge` (227, 229) await theirs;
       - line 211's return type becomes `Promise<Sourced<PersistedAlert & { relatedLogs: LogEntry[] }>>`;
       - in the comments at lines 16 and 94, "into SQLite" becomes "into the configured store" (comment-only).
     - `services/telemetryService.ts`: `metrics` (54), `services` (62) and `service` (67) become `async` with `Promise<…>` return types.
     - `services/aiService.ts`: `listAnalyses` (17) and `getAnalysis` (31) become `async`. `analyze` awaits lines 41, 42, 51 and 66.
     - `services/chatService.ts`: await lines 80, 92 and 106. The failure-path record at line 80 passes `'FAILURE'` as its 5th argument.
     - `services/dashboardService.ts`: `summary` and `health` become `async`. Lines 13–16, 31 and 43–44 await their calls, and line 30 becomes `await repos.alerts.countAll()`. Line 38's type becomes `Promise<Sourced<{ services: ServiceSummary[]; recentMetrics: MetricSnapshot[] }>>`. Keep the statement order.
     - `services/usageService.ts`: `usage` (15) and `cost` (29) become `async`.
     - `services/settingsService.ts`: `get` (141) and `update` (159) become `async`.
     - `services/authService.ts`: `login` awaits lines 29 and 37–39. `me` (58, 60) and `logout` (64) become `async`. `verify` stays sync.
     - `routes/apiRoutes.ts`: line 12 imports `getRepositories`. Lines 32, 36, 93, 100, 104, 111, 116, 158, 159, 180 and 184 become `res.json(await …)`. Line 170 becomes `await getRepositories().audit.query(q)`.
     - `routes/authRoutes.ts`: line 36 becomes `await authService.logout(…)`, and line 45 becomes `res.json({ user: await authService.me(…) })`.
     - `routes/healthRoutes.ts`: drop the `getDb` import (line 3). The `/ready` handler (line 25) becomes `async` and wraps `await getRepositories().health.ping()` in the existing try/catch; the body is unchanged.
     - `integrations/mock/MockDynamoDBAdapter.ts`: lines 15, 20 and 27 become `await getRepositories().alerts.*`, and line 3 changes accordingly. Provenance stays `MOCK`.
     - `server.ts` (§9.4):
       - `async function main()` does `const repos = getRepositories();`, then `runMigrations()` when `repos.driver === 'sqlite'`, else `await assertDynamoReachable(repos)`;
       - the "listening" log gains `dbDriver: repos.driver`;
       - line 36 becomes `main().catch((err) => { logger.error('Startup failed', { message: err instanceof Error ? err.message : String(err) }); process.exit(1); })`;
       - the shutdown handlers are unchanged.
  6. `<wt>\packages\backend\src\db\seed.ts` (§9.3, steps 1–8):
     - `seed()` keeps the production guard first, then `const repos = getRepositories()`.
     - To prepare the store, SQLite runs `runMigrations()`. DynamoDB runs `await repos.health.ping()`; on failure it throws an error whose message ends with `run npm run dynamo:tables first`.
     - Roles, the admin (`upsertUser({…, role: 'SUPER_ADMIN'})` only when `findByEmail` finds none) and `environments.ensure` follow.
     - The raw SQL becomes `services.upsert(s, 'MOCK')`, `alerts.insert(a, 'MOCK', 'OPEN')`, `logs/metrics/usage.upsertMany(…, 'MOCK')`, then the stale-row loop over `integrations.all()` with `integrations.delete`, then 4× `integrations.upsert` with mode `MOCK`, status `WAITING_FOR_INTEGRATION`, `config_json '{}'` and `updated_at now`.
     - The `Seed complete` log line is the same.
     - Export `assertSeedTarget(db, argv)` verbatim from §9.3, throwing `CliPreconditionError`.
     - Rewrite the CLI block (lines 180–187): `assertSeedTarget(config.db, process.argv.slice(2))` runs first, before any repository is built. `CliPreconditionError` → `logger.error(message)` → exit 2. Then `await seed()` and `await getRepositories().close()`. Any other error → `logger.error('Seed failed', { message })` → exit 1.
     - Remove the `getDb`/`closeDb` imports. Keep `export { seed }`.
  7. Test helpers and existing tests (§8.4):
     - `test/setup.ts`: add `process.env.DB_DRIVER = 'sqlite';`.
     - `test/testDb.ts`: `freshTestDb()` also calls `resetRepositories()`, imported from `'../repositories'`.
     - `repositories/alertCorrelation.test.ts`: `let repos: Repositories`, set in `beforeEach` after `freshTestDb()` from `getRepositories()` (imported from `'./index'`). Every `it` becomes `async` with awaited calls. Keep `seedLog`, `evidenceLines` and the `better-sqlite3`/`getDb` imports, which are allowed under `repositories/`.
     - `services/alertService.test.ts`: the `beforeEach` becomes `async` and calls `await getRepositories().alerts.insert(…)`. The re-sync test (lines 65–89) becomes async with awaits.
     - `services/authService.test.ts`: `await repos.users.upsertRole/upsertUser`.
     - **Type-only edit in all three service tests:** delete `import type Database from 'better-sqlite3'` and declare `let db: ReturnType<typeof freshTestDb>;`. Applies to `alertService.test.ts:2`, `authService.test.ts:4` and `chatService.test.ts:2`. `chatService.test.ts` gets only this edit.
     - No assertion is removed or weakened.

  Files:
  - `packages/backend/src/repositories/{types,common,validation,index}.ts`;
  - `repositories/sqlite/*` (6 moved, 4 new);
  - the 8 `services/*.ts`, `routes/{api,auth,health}Routes.ts`, `integrations/mock/MockDynamoDBAdapter.ts`, `server.ts`;
  - `db/seed.ts`, `db/cliErrors.ts`;
  - `test/{setup,testDb}.ts` and the 4 existing test files.

  Verify:
  - V1 (build) and V2 (`npm test`: 73 pre-existing tests plus the migration test, green);
  - V4 (frontend);
  - the AC5 import gate (V3a) prints nothing;
  - SQLite smoke against the baseline:
    ```powershell
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\smoke.ps1" -Driver sqlite -Name feat001 -Seed -Baseline "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\baseline\keysets.json" -CheckDriverLine
    ```
    This must exit 0. A missed `await` shows up here as `{}` key sets.

  Commit, for example `refactor(backend): async driver-agnostic repository layer on SQLite (DPI2 item 1)`.

## FEAT-002 — Repository contract suite and SQLite-side tests (item 6)

- [ ] **6. Contract suite, harness and the default-suite tests for FEAT-001's code.**
  - `<wt>\packages\backend\src\test\repositoryHarness.ts`: `RepositoryHarness`, `sqliteHarness()` and `makeTestClock(startIso = '2026-10-01T00:00:00.000Z', stepMs = 1000)`, as in §8.1. `sqliteHarness.fresh(now)` is `freshTestDb()` plus `createSqliteRepositories({ now })`, and `cleanup` closes that db. `DynamoHarness` comes in item 9.
  - `<wt>\packages\backend\src\test\repositoryContract.ts`: `defineRepositoryContract(harness)`.
    - Hooks: `beforeAll(setupSuite, 60_000)`, `beforeEach` → `repos = await harness.fresh(makeTestClock())`, `afterEach(cleanup)`, `afterAll(teardownSuite)`.
    - The **69 cases of §8.2**, each titled with its id (`'C-AL-01 …'` … `'C-HL-01 …'`), using only the `Repositories` interface. "Rejects" means `rejects.toThrow()` unless a typed `PersistenceError.reason` is named. Fixtures use distinct timestamps, and `relatedLogIds` are compared sorted.
    - C-KY-01 includes the `''` lookups [F34].
  - `<wt>\packages\backend\src\repositories\repositories.contract.test.ts`: the `describe('repository contract [sqlite]', …)` line from §8.1. The dynamodb line is added in item 9.
  - `<wt>\packages\backend\src\repositories\common.test.ts`, following the §8.3 row:
    - the `compileLike`/`likeContains` cases;
    - a fixed table plus 2,000 deterministic pseudo-random pairs cross-checked against better-sqlite3 `SELECT ? LIKE ?` with `'%' + term + '%'`;
    - the AC18 timing case: under 50 ms, result `false`;
    - `compareBinary`, `clampPage`, the cursor round-trip and garbage input, the three cursor schemas, and `newTimeOrderedId` under a frozen clock.
    - No `new RegExp`/`RegExp(` anywhere in the file (AC18 gate).
  - `<wt>\packages\backend\src\config\index.test.ts` (§8.3 row). Use the fresh-config dynamic import of `integrations/index.test.ts`: snapshot `process.env`, set or delete `DYNAMODB_ENDPOINT`/`DYNAMODB_TABLE_PREFIX`, `vi.resetModules()`, `await import('./index')`, restore in `finally`.
    - `''` gives `endpoint === null`;
    - `ftp://x` and `not a url` reject with `/DYNAMODB_ENDPOINT/`;
    - the default `tableName` is `UrbaniApp`;
    - a bad prefix (`'bad prefix!'`) rejects.
  - `<wt>\packages\backend\src\repositories\index.test.ts`: the default `getRepositories().driver === 'sqlite'`; `setRepositoriesForTesting({ audit: fake })` takes effect; `resetRepositories()` builds a new instance. The dynamodb case comes in item 8.
  - `<wt>\packages\backend\src\db\seed.test.ts`:
    - SQLite: after `freshTestDb()` and `seed()`, the counts are 2 roles (`getRole('role-admin'/'role-viewer')`), 1 admin with role `SUPER_ADMIN`, `services.count()` 4, `alerts.countAll()` 3, `logs.query({}).total` 60, `metrics.query({ limit: 500 }).length` 24, `usage.all().length` 7 and `integrations.all().length` 4. A second `seed()` leaves them unchanged.
    - `assertSeedTarget` cases (§8.3). The DynamoDB block comes in item 9.
  - `<wt>\packages\backend\src\test\keySet.ts`: the §14 key-set algorithm, identical to the `capture.mjs` copy.
  - `<wt>\packages\backend\src\routes\routes.test.ts` (§8.3 row):
    - supertest on `createApp()`; `beforeAll` runs `db = freshTestDb(); await seed();`;
    - 27 sequential `it`s replay the capture sequence, carrying `token`, `A` and `N`;
    - each step asserts the status and `keySet(body)` against `routes.baseline.json[stepId]`, and `02` also asserts the exact body;
    - declare `let db: ReturnType<typeof freshTestDb>`, with no `better-sqlite3` import.
  - If a case exposes a SQLite deviation from the design, fix the FEAT-001 code. Never weaken a case.

  Verify:
  - V2 green;
  - `Set-Location "<wt>\packages\backend"; npx vitest run --reporter=verbose`: `repository contract [sqlite]` lists 69 passing `C-` cases, and `routes.test.ts` lists 27 passing steps;
  - V3c (no `RegExp` constructor under `repositories/`).

  Commit (`test(backend): repository contract suite, route shape and helper tests`).

## FEAT-003 — DynamoDB driver (items 7–8)

- [ ] **7. Dependencies and driver infrastructure.**
  - Run in `<wt>`, with no node process from the worktree running (EBUSY on `better-sqlite3` was seen in setup): `npm install @aws-sdk/client-dynamodb@^3.1162.0 @aws-sdk/lib-dynamodb@^3.1162.0 --workspace @urbani/backend`. This updates `packages/backend/package.json` and the root `package-lock.json`. The two packages are on the same version; lib-dynamodb peer-depends on `client-dynamodb ^3.1162.0`.
  - `repositories/dynamodb/client.ts`: `DynamoContext` and `createDynamoContext({ region, endpoint, tableName })`, as in §5.10 plus [P1]. Dummy `local`/`local` credentials are used only when an endpoint is set.
  - `repositories/dynamodb/keys.ts`: the key builders for every §5.2 row, `ENTITY_TYPES` (16 values) and `fitsKey(pk, sk)` with lower bound 1 [F34].
  - `repositories/dynamodb/items.ts`:
    - the 16 builders named in the §5.4 rule, each setting `entityType` and checking every key attribute with [F34] → `INVALID_ARGUMENT`;
    - item-to-record mappers that emit exactly the SQLite mapper's keys, `null` when absent (§5.2), with users rebuilt in snake_case and `is_active: isActive ? 1 : 0`;
    - `budgetEvidence` (`EVIDENCE_BUDGET_BYTES = 256*1024`, warn `{ alertId, keptLines, droppedLines }`);
    - `assertItemSize` (`ITEM_SIZE_LIMIT_BYTES = 380*1024` → `ITEM_TOO_LARGE`), as in §5.8.
  - `repositories/dynamodb/ops.ts`: the **only** module that imports `QueryCommand`, `BatchGetCommand` or `BatchWriteCommand`.
    - `send(ctx, command, op, opts?)`;
    - `translateAwsError(err, op)`, following the §5.10 table; it logs op, AWS error name and requestId only;
    - `queryAll`, `queryCount`, `queryUpTo`, `batchGetAll` and `batchWriteAll` with the §5.7 signatures and retry rules;
    - a concurrency helper, `mapLimit(items, 8, fn)`.
  - `repositories/dynamodb/links.ts`: `unlinkAll(ctx, alertId)` (§5.4).
  - `repositories/dynamodb/tableDefinition.ts`: `APP_TABLE_GSI1 = 'GSI1'` and `buildCreateTableInput(tableName)` (§9.5: `PK`/`SK`/`GSI1PK`/`GSI1SK` as S, `GSI1` with projection ALL, `PAY_PER_REQUEST`). Add a comment pointing at `infra/lib/persistence-construct.ts`.

  Verify: `npm run build` exit 0; `npm test` green with nothing new yet.

- [ ] **8. DynamoDB repositories, factory, registry branch and default-suite unit tests.**
  - `repositories/dynamodb/{alert,telemetry,user,preferences,ai,audit,integration,chat,health}Repository.ts`. Implement the §5.3 patterns 1–47 (7 is not implemented) with the §5.4 algorithms.
    - Every expression uses `#name`/`:value` placeholders.
    - Every update that mirrors a SQL `UPDATE` carries `attribute_exists(#pk)`.
    - The three create-capable UpdateItems SET `#entityType`, and `preferences.update` also SETs `#userId`.
    - The live-upsert SET list is generated from `items.alertItem(alert, 'LIVE', 'OPEN')`, minus `PK`, `SK`, `status`, `acknowledgedBy` and `acknowledgedAt`, plus `#status = if_not_exists(#status, :open)`.
    - `upsertUser` follows the §5.4 decision table. `findByEmail` always does two GetItems.
    - Every base-table read uses `ConsistentRead: true`, and no GSI query does.
    - The key guard applies to lookups (§5.4 list).
    - `health.ping` uses `ConsistentRead: true` and `abortSignal: AbortSignal.timeout(2000)`.
  - `repositories/dynamodb/index.ts`: `createDynamoRepositories(ctx, opts?)` sets `driver: 'dynamodb'` and `close: async () => ctx.destroy()`.
  - `repositories/index.ts`: replace the FEAT-001 placeholder with the §3.3 dynamodb branch, including the info log `Persistence driver: dynamodb` with `{ table, region, endpoint ?? 'aws-default-chain' }` and the production endpoint warning.
  - Tests (default suite, no Docker):
    - `repositories/dynamodb/items.test.ts`: the §8.3 row, plus the [F34] empty-id → `INVALID_ARGUMENT` case.
    - `repositories/dynamodb/commands.test.ts`: the §8.3 row. The recording fake is `{ send: vi.fn(async (cmd) => …) }`, and it derives `kind = cmd.constructor.name.replace(/Command$/, '')`. **Test code never spells `QueryCommand`/`BatchGetCommand`/`BatchWriteCommand`** (AC19 gate).
    - `repositories/index.test.ts`, dynamodb case: fresh-config import with `DB_DRIVER=dynamodb` and `DYNAMODB_ENDPOINT=http://127.0.0.1:9`. Assert `driver === 'dynamodb'`, and that `vi.spyOn(http, 'request')` and `vi.spyOn(https, 'request')` saw zero calls.

  Verify: V1; V2 green; V3b (AC19) and V3c (AC18) print nothing. Commit (`feat(backend): DynamoDB single-table persistence driver`).

## FEAT-004 — DynamoDB tooling, DynamoDB Local integration, migration script (items 9–11)

- [ ] **9. Table tooling, the DynamoDB harness and the opt-in DynamoDB tests, run on DynamoDB Local.**
  - `<wt>\packages\backend\src\db\dynamoTables.ts` (§9.5):
    - `TablesArgs` and `parseTablesArgs` (only `--reset`; anything else → `CliPreconditionError(usage)`);
    - `assertLocalEndpoint` (presence only; refusal text `Refusing: dynamo:tables only targets DynamoDB Local (set DYNAMODB_ENDPOINT). Cloud tables come from infra/ (CDK).`);
    - `ensureAppTable(client, tableName, { reset })`: DescribeTable; verify the key schema and GSI name, otherwise `CliPreconditionError` "run with --reset"; reset deletes, waits and recreates; create uses `waitUntilTableExists` with a 60 s limit;
    - `runTables(cfg, argv)`: it prints the table, the endpoint and the action, and destroys the client in `finally`.
  - `src/test/repositoryHarness.ts`: add `DynamoHarness` and `dynamoHarness(endpoint)` (§8.1).
    - The table is `UrbaniTest<runId>App`.
    - `setupSuite` calls `ensureAppTable`.
    - `fresh` purges with a paginated Scan plus `batchWriteAll` deletes, then calls `createDynamoRepositories(ctx, { now })`.
    - `teardownSuite` deletes the table and destroys the client.
    - `scanAll` returns every item.
    - Construction is lazy: no I/O until `setupSuite`.
  - `repositories/repositories.contract.test.ts`: add the `describe.skipIf(!endpoint)('repository contract [dynamodb] (set DYNAMODB_ENDPOINT to run)', { timeout: 20_000 }, …)` line (§8.1).
  - `repositories/dynamodb/dynamoOnly.test.ts`: the §8.3 row. It is skip-if-no-endpoint with a 20 s timeout and its own harness, and covers the evidence trim warning, `ITEM_TOO_LARGE`, and every create path once followed by `scanAll()` with all 16 `entityType` values.
  - `db/seed.test.ts`: add the DynamoDB block (§8.3). `beforeEach` does `setRepositoriesForTesting(await harness.fresh(clock))`, and `afterEach` does `resetRepositories()` plus `harness.cleanup()`. It asserts the same counts and idempotency.
  - Run on DynamoDB Local: V7 pre-flight, V8.1 and V8.2 (start), then V8.3 (opt-in `npm test`, 0 skipped), then V8.7 (stop).
    - Fix any driver bug the contract reveals in the FEAT-003 files. Never weaken a case.
    - If a GSI-dependent case flakes, add the §15.5 bounded retry helper (at most 1 s) in the harness only.

  Verify: V2 green (the dynamodb blocks are reported skipped). The opt-in run passes with 0 skipped, and the container is stopped afterwards.

- [ ] **10. SQLite → DynamoDB migration script.**
  - `<wt>\packages\backend\src\db\migrateSqliteToDynamo.ts` implements every §10 export.
    - `parseMigrateArgs(argv, baseDir?)` has no file-system access, resolves against `INIT_CWD ?? cwd`, and rejects stray tokens [F33].
    - `MIGRATION_ENTITIES`, `EntityCounts`, `MigrationReport` and `SqliteSnapshot` follow §10.
    - `readSqliteSnapshot(db)` detects the schema with `PRAGMA table_info`. A 001-only source gets the role and result defaults plus the `FAILURE` backfill rule, and missing new tables count as 0 rows.
    - `migrateSqliteToDynamo({ snapshot, ctx, dryRun, sourcePath, endpoint })`:
      - writes are create-only, in dependency order, with concurrency 8;
      - users go through a transaction with `emailLockItem`; a `[1]`-only failure counts as `failed` and is logged as a conflict;
      - a dry run checks existence with `batchGetAll`;
      - the evidence budget applies and fills `trimmedEvidence`;
      - every item comes from the `items.ts` builders.
    - `runMigrate(cfg, argv)` checks the preconditions in the §10 order:
      1. parse;
      2. print `Source (read-only): <abs>` with `console.log`;
      3. `statSync(...).isFile()`;
      4. the AWS guard with the [F33] text, before the file is opened or any client exists;
      5. open with `new Database(source, { readonly: true, fileMustExist: true })`;
      6. `health.ping`, mapped per [F32].
      It then prints `console.table` per entity and `logger.info('Migration summary', report)`, returns 1 when `totals.failed > 0` and 0 otherwise, and destroys the client in `finally`.
  - `<wt>\packages\backend\src\db\migrateSqliteToDynamo.test.ts`: the §8.3 row. `readSqliteSnapshot` on in-memory 001-only and 002 databases runs in the default suite. The opt-in block uses its own harness and covers the dry run (empty table), the real run with spot checks, `entityType` on every scanned item, chat and preferences read back equal to SQLite, a re-run that skips everything, and `relatedMetricIds`.

  Verify: V2 green, then the opt-in run on DynamoDB Local (V7, V8.1–8.3, V8.7) with 0 skipped.

- [ ] **11. CLI entry point, guards, scripts and compose profile.**
  - `<wt>\packages\backend\src\db\cli.ts` (§9.5):
    - its top-level value imports are only `./cliErrors` and `../lib/errors`;
    - `export async function main(argv): Promise<number>` dispatches `tables` and `migrate` through `await import()`;
    - an unknown command or a config import error prints to stderr and returns 2;
    - `CliPreconditionError` → 2; a fatal `PersistenceError` → 2; anything else → 1;
    - `if (require.main === module) void main(process.argv.slice(2)).then((code) => process.exit(code));`.
  - `<wt>\packages\backend\src\db\cli.test.ts` (§8.3.1):
    - the pure-function cases, plus the stray-token case [F33];
    - source-path resolution;
    - the six `main()` cases, re-importing `./cli` after every `vi.resetModules()` with a `vi.mock('../repositories/dynamodb/client')` spy;
    - the AWS-refusal case also asserts the [F33] text through a `process.stderr.write` spy;
    - temporary files go only under `fs.mkdtempSync(path.join(os.tmpdir(), 'urbani-cli-'))`.
  - `<wt>\packages\backend\src\db\migrate.ts`: in the CLI block (line 60), before `runMigrations()`, when `config.db.driver !== 'sqlite'`, log info `No SQL migrations for DB_DRIVER=dynamodb (table schema: dynamo:tables / IaC)` and exit 0. Add `import { config } from '../config'`.
  - `<wt>\packages\backend\src\db\reset.ts`: the first statement of `reset()` (line 13), before the production guard and before `getDb()`, throws `reset is SQLite-only. For DynamoDB Local run \`npm run dynamo:tables -- --reset\`` when the driver is not `sqlite`. The existing CLI catch exits 1.
  - `<wt>\packages\backend\package.json` scripts: `"dynamo:tables": "ts-node src/db/cli.ts tables"`, `"dynamo:migrate": "ts-node src/db/cli.ts migrate"`.
  - `<wt>\package.json` scripts: `"dynamo:tables": "npm run dynamo:tables --workspace @urbani/backend --"`, `"dynamo:migrate": "npm run dynamo:migrate --workspace @urbani/backend --"`. The existing `seed`/`migrate` aliases are unchanged.
  - `<wt>\docker-compose.yml`: the §9.1 `dynamodb-local` service (profile `dynamodb`, `127.0.0.1:8000:8000`, `-sharedDb -inMemory`, network `urbani_net`), inserted after `frontend` (ends line 85), before `volumes:` (line 87). `backend` is unchanged.

  Verify, in this order:
  - V1 and V2 green;
  - V6, which creates the `--source` file that V8.5 and V9 use;
  - V7, then the V9 guards with all expected codes and texts;
  - `Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2"; $env:JWT_SECRET='dev'; docker compose --profile dynamodb config --services` lists `dynamodb-local`, and no container starts;
  - V8.1–8.2, V8.4–8.5 (tables, seed twice, the migrate dry run twice, the real run, the re-run), then V8.7.

  Commit (`feat(backend): DynamoDB Local tooling, opt-in integration tests and SQLite→DynamoDB migration`).

## FEAT-005 — IaC (authored only) and documentation (items 12–13)

- [ ] **12. IaC and the offline check (§11).**
  - `<wt>\infra\config\index.ts`: add `dynamoTablePrefix` (`ctx(scope, 'dynamoTablePrefix', process.env.URBANI_DYNAMODB_TABLE_PREFIX, 'Urbani')`) and `appTableName`, both typed in `UrbaniConfig`.
  - `<wt>\infra\lib\persistence-construct.ts`:
    - import `aws_iam as iam` and `Stack`;
    - add `export const APP_TABLE_GSI1 = 'GSI1'`, `readonly appTable`, `private readonly key`, the `UrbaniApp` table plus `GSI1`, and `grantAppDataAccess(grantee)`, all verbatim from §11;
    - leave `alertsTable` untouched.
  - `<wt>\infra\lib\security-construct.ts`: import `Stack`; add `readonly dashboardTaskRole` (§11), with the `ecs-tasks.amazonaws.com` principal and the `aws:SourceAccount` condition.
  - `<wt>\infra\lib\dashboard-construct.ts`:
    - the constructor becomes `(scope, id, cfg, taskRole?: iam.IRole)`, importing `aws_iam as iam`, and passes `taskRole` to `FargateTaskDefinition`;
    - `DB_DRIVER` stays `'sqlite'`, with the item 14 comment;
    - update the persistence NOTE to point at the app table.
  - `<wt>\infra\lib\urbani-dpi-stack.ts`: `persistence.grantAppDataAccess(security.dashboardTaskRole)`, pass the role to `DashboardConstruct`, and add `new CfnOutput(this, 'AppTableName', { value: persistence.appTable.tableName })`.
  - `<wt>\infra\package.json`: add `"check": "ts-node test/app-table.check.ts"`. `<wt>\infra\tsconfig.json`: `include` gains `"test/**/*.ts"`.
  - `<wt>\infra\test\app-table.check.ts`: the 6 §11 assertions, using `Template`/`Match` from `aws-cdk-lib/assertions` and `node:assert/strict`.
    - Build `new UrbaniDpiStack(new App(), 'UrbaniDpiCheck')` with no `env`.
    - Find resources by `TableName`/`RoleName`. Compare action lists sorted.
    - The ViaService value is a token (a `Fn::Join` with `AWS::Region`), so match its shape.
    - If `Template.fromStack` demands a concrete env, use the §15.7 dummy env (`111111111111`/`us-east-1`).
  - Do not touch `deploy-ecs.sh` or `redeploy.sh`.

  Verify: V5 (`npm ci`, `npx tsc --noEmit`, `npm run check`, each exit 0). No CDK CLI.

- [ ] **13. Documentation.**
  - `<wt>\docs\adr\0001-dynamodb-persistence.md`: the 14-part outline of §12.1.
    - Include the §5.2 key table and the §5.3 access-pattern table (patterns 1–47; pattern 7 marked "not implemented in item 1").
    - The accepted divergences include "empty ids" [F34].
    - Include the scale thresholds (about 1,000 alerts or 3 MB per entity partition) and the item 2 follow-up (create-user must require an explicit role).
  - `<wt>\.env.example`:
    - in the Database block (lines 43–47), the `DB_DRIVER` comment becomes `sqlite (default; DPI 1 behaviour) | dynamodb (DPI 2)`, followed by `DYNAMODB_TABLE_PREFIX=Urbani` and `DYNAMODB_ENDPOINT=` with one-line comments;
    - the DynamoDB block (line 99) gains the `UrbaniAlerts`-is-pipeline line;
    - append the §12.2 "Persistence drivers" section, with every command in bash and PowerShell form.
  - `<wt>\infra\README.md`: in the construct table rows `SecurityConstruct` (line 12) and `PersistenceConstruct` (line 13), mention `UrbaniDashboardTaskRole` and the `UrbaniApp` table with `GSI1`. In Usage, add `npm run check   # offline template assertions (no AWS)`.

  Verify: V1 and V2 still green (docs only). The ADR contains the decision, the access-pattern table, the divergences and the thresholds. `.env.example` contains `DYNAMODB_TABLE_PREFIX`, `DYNAMODB_ENDPOINT` and `Persistence drivers`.

  Commit (`feat(infra): UrbaniApp table and dashboard task role (authored, not deployed)`, then `docs: ADR 0001 DynamoDB persistence and persistence-driver guide`).

## Integration and report

- [ ] **14. Cross-feature verification and seam fixes.** Run V1–V10 in order. Fix any seam between features, re-running the affected checks plus V2. Record every command, its exit code and the key output lines, including test totals (total, passed, skipped, and the 73 pre-existing tests by file) and whether DynamoDB Local was exercised, in `C:/Antigravity/Urbani DPI/.agents/tasks/dpi2/item-01/verification.md`. Commit fixes, if any, on `dpi2`.

  Files: any seam fix; `verification.md` (outside the repository).

  Verify: every V-step meets its expectation. `git -C "<wt>" status --short` is clean after the commit.

- [ ] **15. Report and tracker** (main-workspace files, not committed).
  - Write `C:/Antigravity/Urbani DPI/.agents/tasks/dpi2/item-01-report.md`. It covers:
    - the data model and why, linking `docs/adr/0001-dynamodb-persistence.md`;
    - the files changed (`git -C "<wt>" diff --stat 5c81908..HEAD`);
    - the tests added and updated, with counts;
    - the exact V1–V10 results, stating whether DynamoDB Local was exercised;
    - the dpi2 HEAD hash;
    - the FR5.4 type-only test edit;
    - the item 2 follow-up from FR3.1;
    - the tracked stale `packages/backend/data/*-wal/-shm` files, flagged for a separate cleanup;
    - a "To go LIVE" section built from design Appendix B, with Appendix A's policy.
  - In `C:/Antigravity/Urbani DPI/.agents/tasks/dpi2/BACKLOG.md`, set item 1's Status to `DONE (integration pending)`. Append a Progress-log entry with the date, `#1`, the dpi2 commit hash, a one-paragraph summary, what is pending from the client (AWS account and region, table creation and task-role permissions, `DB_DRIVER=dynamodb` with the migration) and a link to the report.

  Verify: both files exist, and the report's hash equals `git -C "<wt>" rev-parse HEAD`.

---

## V. Verification checklist (exact commands)

All commands are PowerShell. Absolute paths are quoted. Read `$LASTEXITCODE` after each native command.

- **V1 Build.** `Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2"; npm run build; "exit=$LASTEXITCODE"`. Expect 0, with shared, backend and frontend built.
- **V2 Default tests.**
  ```powershell
  Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2"; Remove-Item Env:DYNAMODB_ENDPOINT -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force .tmp\verify | Out-Null; npm test 2>&1 | Tee-Object -FilePath .tmp\verify\npm-test-default.txt; "exit=$LASTEXITCODE"
  ```
  Expect exit 0, with every DynamoDB block reported as skipped. The 11 pre-existing files keep their counts:
  - `HttpUrbaniLogsAdapter` 13, `alertService` 12, `HttpUrbaniAlertsAdapter` 8, `alertCorrelation` 5, `HttpUrbaniChatProvider` 8;
  - `MockAIProvider` 4, `markdown` 8, `logLineParser` 6, `chatService` 1, `integrations/index` 4, `authService` 4;
  - 73 in total.

  For per-test names, run `Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2\packages\backend"; npx vitest run --reporter=verbose`: 69 `C-` cases pass under `[sqlite]` and 27 route steps pass.
- **V3 Static gates.** Each command must print nothing. Run them from `Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2\packages\backend\src"`.
  - a (AC5): `Get-ChildItem -Recurse -File -Filter *.ts | Where-Object { $_.FullName -notmatch '\\src\\(repositories|db|test)\\' } | Select-String -Pattern "from '[^']*db/connection'|from 'better-sqlite3'|from '@aws-sdk/|require\('better-sqlite3'\)"`
  - b (AC19): `Get-ChildItem -Recurse -File -Filter *.ts | Select-String -Pattern 'QueryCommand|BatchGetCommand|BatchWriteCommand' | Where-Object { $_.Path -notmatch '\\repositories\\dynamodb\\ops\.ts$' }`
  - c (AC18): `Get-ChildItem -Path .\repositories -Recurse -File -Filter *.ts | Select-String -Pattern 'new RegExp|RegExp\('`
  - d (AC6): `Get-ChildItem -Path .\services, .\routes, .\integrations\mock, .\db -Recurse -File -Filter *.ts | Select-String -Pattern '(repos|getRepositories\(\))\.\w+\.\w+\(' | Where-Object { $_.Line -notmatch '\bawait\b|\breturn\b' }`, plus `Select-String -Path .\server.ts -Pattern 'getRepositories|assertDynamoReachable'` for review. Also review every changed caller by hand.
  - e: `git -C "C:\Antigravity\Urbani DPI\.worktrees\dpi2" diff --stat 5cc5ffa -- packages/frontend` must be empty.
- **V4 Frontend.** `Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2\packages\frontend"; npx tsc -b --noEmit; "exit=$LASTEXITCODE"`. Expect 0.
- **V5 Infra.** `Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2\infra"; npm ci; "ci=$LASTEXITCODE"; npx tsc --noEmit; "tsc=$LASTEXITCODE"; npm run check; "check=$LASTEXITCODE"`. Expect 0 / 0 / 0. Do not run the CDK CLI.
- **V6 SQLite smoke on port 4100.** The database is `<wt>\.tmp\smoke\sqlite\urbani.sqlite`, which is git-ignored and never under `packages/backend/data`.
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\smoke.ps1" -Driver sqlite -Name sqlite -Seed -Baseline "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\baseline\keysets.json" -CheckDriverLine; "exit=$LASTEXITCODE"
  ```
  Expect 0: every step's status and key set equal the baseline, step 02 returns 200, the driver line shows the `.tmp\smoke\sqlite` path, and port 4100 is free afterwards. Login, alerts, logs, audit and settings are steps 03, 07, 10, 19/26 and 17/25.
- **V7 AWS pre-flight [F31].** Run it before V8 and V9. Stop and report if either check finds something. Never open the cache files.
  ```powershell
  (Test-Path "$HOME\.aws\credentials") -or (Test-Path "$HOME\.aws\config"); Get-ChildItem Env: | Where-Object Name -match '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|WEB_IDENTITY_TOKEN_FILE|CONTAINER_CREDENTIALS_)' | Select-Object Name
  ```
  Expect `False` and no names.
- **V8 DynamoDB Local.** Docker engine 29.8.0 was reachable while planning. If no engine is available, use the §9.2 jar fallback. If neither works, record "DynamoDB Local NOT exercised", with the reason.
  1. `docker version --format '{{.Server.Version}}'` prints a version.
  2. Start the container and wait until it is ready:
     ```powershell
     docker run -d --rm --name urbani-dynamodb-local -p 127.0.0.1:8000:8000 amazon/dynamodb-local:2.5.2 -jar DynamoDBLocal.jar -sharedDb -inMemory; $ready=$false; for ($i=0; $i -lt 60 -and -not $ready; $i++) { Start-Sleep -Milliseconds 500; $ready = ((docker logs urbani-dynamodb-local 2>&1) | Out-String) -match 'CorsParams' }; "ready=$ready"
     ```
  3. `Set-Location "C:\Antigravity\Urbani DPI\.worktrees\dpi2"; $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm test 2>&1 | Tee-Object -FilePath .tmp\verify\npm-test-dynamodb.txt; "exit=$LASTEXITCODE"`. Expect 0. `repository contract [dynamodb]` passes 69/69 with 0 skipped, and the other opt-in tests pass.
  4. ENV-DYNAMO(`UrbaniSmoke`); `npm run dynamo:tables; "exit=$LASTEXITCODE"`. Expect 0 and `created`. If it reports `exists` (a reused container), run ENV-DYNAMO(`UrbaniSmoke`); `npm run dynamo:tables -- --reset` so the smoke starts from an empty table. Then run ENV-DYNAMO(`UrbaniSmoke`); `npm run seed; "exit=$LASTEXITCODE"` **twice**. Both exit 0; the second run logs `Admin user already exists; skipping`; both show `Persistence driver: dynamodb` with `"endpoint":"http://127.0.0.1:8000"`.
  5. ENV-DYNAMO(`UrbaniMigrate`); `npm run dynamo:tables`, adding `-- --reset` if it reports `exists`. Then, with ENV-DYNAMO(`UrbaniMigrate`):
     ```powershell
     npm run dynamo:migrate -- --source "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\sqlite\urbani.sqlite" --dry-run; "exit=$LASTEXITCODE"
     ```
     Run it twice. Each run prints `Source (read-only): C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\sqlite\urbani.sqlite`, and both report the same would-create counts with 0 would-skip. Then run once without `--dry-run` (created counts, exit 0), and once more (everything skipped, exit 0).
  6. Run the DynamoDB smoke:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\smoke.ps1" -Driver dynamodb -Name dynamodb -Prefix UrbaniSmoke -Baseline "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\baseline\keysets.json" -CheckDriverLine; "exit=$LASTEXITCODE"
     ```
     Expect 0. Then the totals must equal the SQLite smoke:
     ```powershell
     $w='C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke'; function J($d,$s){ Get-Content "$w\$d\$s.json" -Raw | ConvertFrom-Json }; "alerts: $((J sqlite 07-get-alerts).data.total) / $((J dynamodb 07-get-alerts).data.total)"; "services: $((J sqlite 12-get-services).data.Count) / $((J dynamodb 12-get-services).data.Count)"; "usage: $((J sqlite 15-get-usage).data.records.Count) / $((J dynamodb 15-get-usage).data.records.Count)"
     ```
     The pairs must be equal: 3, 4 and 7. To repeat V8.6, first reset the table and seed it again (V8.4), because the capture writes analyses, audit events and an acknowledgement.
  7. Stop and clean up: `docker stop urbani-dynamodb-local; docker ps -a --filter name=urbani-dynamodb-local -q; Test-Path "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\dynamo-unused\urbani.sqlite"`. Expect no container listed and `False`.
- **V9 Guards (AC11) [F33].** Each runs in a fresh call that starts with ENV-GUARD and adds only the variables shown. Expected exit codes and texts are in brackets.
  - `npm run dynamo:tables; "exit=$LASTEXITCODE"` [2; `Refusing: dynamo:tables only targets DynamoDB Local`]
  - `npm run dynamo:migrate -- --source "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\sqlite\urbani.sqlite"; "exit=$LASTEXITCODE"` [2; `Refusing: dynamo:migrate would target AWS DynamoDB. Pass --allow-aws, or set DYNAMODB_ENDPOINT for DynamoDB Local.`]
  - `$env:DYNAMODB_ENDPOINT='ftp://x'; npm run dynamo:migrate -- --source "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\sqlite\urbani.sqlite"; "exit=$LASTEXITCODE"` [2; the message names `DYNAMODB_ENDPOINT`]
  - `$env:DB_DRIVER='dynamodb'; npm run seed; "exit=$LASTEXITCODE"` [2; `Refusing: seeding an AWS DynamoDB table needs --allow-aws`]
  - `$env:DB_DRIVER='dynamodb'; npm run reset --workspace @urbani/backend; "exit=$LASTEXITCODE"` [1; the message names `dynamo:tables -- --reset`]
  - Afterwards `Test-Path "C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\guard\unused.sqlite"` prints `False`.
- **V10 Hygiene.**
  - `git -C "C:\Antigravity\Urbani DPI\.worktrees\dpi2" status --short`: no `.env`, `.tmp/` or `packages/backend/data/*` entries.
  - `git -C "C:\Antigravity\Urbani DPI\.worktrees\dpi2" diff 5c81908 -- .gitignore`: only `+.tmp/`.
  - `Get-NetTCPConnection -LocalPort 4100,8000 -State Listen -ErrorAction SilentlyContinue`: nothing.
  - `git -C "C:\Antigravity\Urbani DPI" rev-parse main`: `5cc5ffa05d41f47c61dc6d5c423bda51cc11b188`.
  - `git -C "C:\Antigravity\Urbani DPI" status --short --untracked-files=no`: nothing, so no tracked change in the main workspace.
  - `git -C "C:\Antigravity\Urbani DPI\.worktrees\dpi2" branch --show-current`: `dpi2`. There is no upstream, and nothing was pushed.

---

## Digest

### Verified while planning (5 Nov 2026)
- **Worktree.** `<wt>` is on `dpi2` at `5c81908`, clean; `main` = `5cc5ffa05d41f47c61dc6d5c423bda51cc11b188`; `git worktree list` shows both. There is no `.env` in `<wt>` or `<wt>\packages\backend`. `<wt>\packages\shared\dist` exists, and `<wt>\infra\node_modules` is absent.
- **Tests.** `npm test` at `<wt>`: vitest 2.1.9, **11 files, 73/73 passed**, with the per-file counts in V2.
- **Build and type checks.** `npm run build` at `<wt>` exits 0, and `git status` stays clean afterwards. `npx tsc -p packages/backend/tsconfig.json --noEmit` exits 0, and `npx tsc -b --noEmit` in `packages/frontend` exits 0.
- **Host.**
  - Node v24.13.0, npm 11.6.2, Docker server 29.8.0 (reachable).
  - The only relevant inherited variable is `LOG_LEVEL=error`.
  - There is no `~/.aws/credentials` or `~/.aws/config`, and no `AWS_*` credential variable.
- **Process lifetime.** `Start-Process … -WindowStyle Hidden -RedirectStandardOutput …` inherits `$env:` values, but the shell tool kills the process when the call returns. That is why `smoke.ps1` does start, capture and stop in one call.
- **npm registry.** `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` latest = `3.1162.0`, and lib-dynamodb peer-depends on `@aws-sdk/client-dynamodb ^3.1162.0`.
- **Code inventory.** The design's §2.1–§2.3 inventory and line numbers match the code I read. The repository imports grep finds no caller beyond §2.2.

### FEAT-001 files
| File | Block to change (signature, lines) | Covered by |
|---|---|---|
| `.gitignore` | append `.tmp/` after line 42 `.worktrees/` | item 1 probe, V10 |
| `packages/shared/src/domain.ts` | insert enums between `interface AuditEvent` (86–94) and `dashboardSummarySchema` (95) | V1, contract C-AU-04, C-UR-02/08 |
| `packages/backend/src/lib/errors.ts` | append after `ServiceUnavailableError` (63–67) | contract cases asserting `.reason` |
| `packages/backend/src/config/index.ts` | schema after line 85; `db` block 173–176 | `config/index.test.ts` |
| `repositories/types.ts`, `common.ts`, `validation.ts` (new) | §3.2, §4.5, §7.3 | `common.test.ts`, contract |
| `db/cliErrors.ts` (new) | `class CliPreconditionError` | `seed.test.ts`, `cli.test.ts` |
| `db/migrations/002_dpi2_persistence_foundation.sql` (new) | §4.4 | `db/migrations.test.ts`, all tests via `freshTestDb` |
| `repositories/alertRepository.ts` → `sqlite/` | `alertRepository` object line 92 → `sqliteAlertRepository(ctx)`; methods 93/141/198/205/244/261/266/277/285; `AlertFilter` (14) → types; `this.findById` (273–274) → local sync helper; add `countAll` | `alertCorrelation.test.ts`, `alertService.test.ts`, C-AL-* |
| `repositories/telemetryRepository.ts` → `sqlite/` | `serviceRepository` 22, `mapService` 36 (per-row COUNT kept), `LogFilter` 53 → types, `logRepository` 62 (97/115/125), `metricRepository` 135, `usageRepository` 167; add `upsert`, `upsertMany`, environments | C-SV/LG/MT/US-*, `seed.test.ts` |
| `repositories/userRepository.ts` → `sqlite/` | `RoleRow`/`UserRow`/`AuthUser` (10/18/29) → types; methods 42–103; `upsertUser` SQL → §4.3 | `authService.test.ts`, C-UR-* |
| `repositories/aiRepository.ts` → `sqlite/` | `AIAnalysisRecord` (12) → types; `insert` 33 (`created_at` → `ctx.now()`), `query` 63, `findById` 73, `count` 78 | C-AI-*, route steps 18/20/22/23 |
| `repositories/auditRepository.ts` → `sqlite/` | `record` 33 (+`result`), `query` 44 unchanged, `rowTo` 21 unchanged; add `listByTimeRange` | C-AU-*, route steps 19/26 |
| `repositories/integrationRepository.ts` → `sqlite/` | `IntegrationRow` (9) → types; `all` 24; add `upsert`, `delete` | C-IN-01, route step 17 |
| `sqlite/{preferences,chat,health}Repository.ts`, `sqlite/index.ts`, `repositories/index.ts` (new) | §4.5, §3.3 | C-PF/CH/HL-*, `index.test.ts`, route step 02 |
| `services/alertService.ts` | lines 2–4, 115, 118, 166–171, 194, 211, 213, 215, 220, 227, 229; comment lines 16 and 94 | `alertService.test.ts`, route steps 07–09/24 |
| `services/telemetryService.ts` | `metrics` 50–56, `services` 58–64, `service` 66–70; import lines 3–7 | route steps 11–14 |
| `services/aiService.ts` | `listAnalyses` 16–28, `getAnalysis` 30–32, `analyze` 41/42/51/66; imports 3–4 | route steps 18/20/22/23 |
| `services/chatService.ts` | lines 5–6, 80 (+`'FAILURE'`), 92, 106 | `chatService.test.ts`, route step 21 |
| `services/dashboardService.ts` | `summary` 12–35 (line 30 → `countAll`), `health` 38–47; imports 2–4 | route steps 05/06 |
| `services/usageService.ts` | `usage` 14–26, `cost` 28–59; import 3 | route steps 15/16 |
| `services/settingsService.ts` | `get` 86 (line 141), `update` 158–167; imports 3–4 | route steps 17/25 |
| `services/authService.ts` | `login` 29/37–39, `me` 57–61, `logout` 63–65; imports 5–6 | `authService.test.ts`, route steps 03/04/27 |
| `routes/apiRoutes.ts` | import 12; lines 32, 36, 93, 100, 104, 111, 116, 158, 159, 170, 180, 184 | `routes.test.ts`, V6 |
| `routes/authRoutes.ts` | lines 36, 45 | route steps 04/27 |
| `routes/healthRoutes.ts` | import 3; `/ready` 25–40 (`getDb` at 30) | route step 02 |
| `integrations/mock/MockDynamoDBAdapter.ts` | import 3; lines 15, 20, 27 | route step 20 |
| `server.ts` | import 4; `main` 14–33; call 36 | V6 (driver line), V8.6 |
| `db/seed.ts` | imports 3–8; `seed()` 27–178; CLI block 180–187 | `seed.test.ts`, `routes.test.ts`, V6, V8.4, V9 |
| `test/setup.ts`, `test/testDb.ts` | add the `DB_DRIVER` line; `freshTestDb` adds `resetRepositories()` | whole suite |
| `repositories/alertCorrelation.test.ts`, `services/{alertService,authService,chatService}.test.ts` | §8.4 edits; type-only edit at `alertService.test.ts:2`, `authService.test.ts:4`, `chatService.test.ts:2` | themselves (73 preserved) |
| `packages/backend/src/routes/routes.baseline.json` (new) | captured in item 1 | `routes.test.ts` |

### FEAT-002 files (all new)
`src/test/{repositoryHarness,repositoryContract,keySet}.ts`, `src/repositories/{repositories.contract,common,index}.test.ts`, `src/config/index.test.ts`, `src/db/seed.test.ts`, `src/routes/routes.test.ts`. Covered by V2, the verbose list and V3c.

### FEAT-003 files
- `packages/backend/package.json` dependencies and the root `package-lock.json`: `npm install` (item 7).
- New: `repositories/dynamodb/{client,keys,items,ops,links,tableDefinition,index}.ts` and the 9 repository files.
- `repositories/index.ts`: replace the dynamodb placeholder in `build()`.
- Tests: `dynamodb/{items,commands}.test.ts`, plus the `index.test.ts` dynamodb case.
- Covered by V2, V3b and V3c, and later by V8.3.

### FEAT-004 files
- New: `db/dynamoTables.ts`, `db/migrateSqliteToDynamo.ts`, `db/cli.ts`, `db/{migrateSqliteToDynamo,cli}.test.ts`, `repositories/dynamodb/dynamoOnly.test.ts`.
- Modified:
  - `src/test/repositoryHarness.ts`: add the DynamoDB harness;
  - `repositories/repositories.contract.test.ts`: add the dynamodb line;
  - `db/seed.test.ts`: add the DynamoDB block;
  - `db/migrate.ts`: the CLI block at line 60;
  - `db/reset.ts`: `reset()` at line 13;
  - `packages/backend/package.json` and the root `package.json` scripts;
  - `docker-compose.yml`: before `volumes:` at line 87.
- Covered by V2, V8.3–8.5 and V9.

### FEAT-005 files
- `infra/config/index.ts`: `UrbaniConfig` and `loadConfig`.
- `infra/lib/persistence-construct.ts`: the constructor after `alertsTable`, and the new method.
- `infra/lib/security-construct.ts`: the constructor end.
- `infra/lib/dashboard-construct.ts`: the constructor signature and `FargateTaskDefinition` props; env `DB_DRIVER` stays.
- `infra/lib/urbani-dpi-stack.ts`: after the `PersistenceConstruct`/`DashboardConstruct` lines.
- `infra/package.json` scripts and `infra/tsconfig.json` `include`.
- New `infra/test/app-table.check.ts`.
- `infra/README.md` lines 12–13 and Usage.
- New `docs/adr/0001-dynamodb-persistence.md`.
- `.env.example`: lines 43–47 and 99, plus the new section at the end.
- Covered by V5, V1 and V2.
