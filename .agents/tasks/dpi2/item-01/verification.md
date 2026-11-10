# Verification — DPI 2 item 1 (persistence foundation)

Worktree `C:\Antigravity\Urbani DPI\.worktrees\dpi2`, branch `dpi2`. All commands are PowerShell 5.1 on Windows, Node v24.13.0. Exit codes come from `$LASTEXITCODE`. Raw outputs are under `<wt>\.tmp\verify\` (git-ignored).

## Iteration 1 — cross-FEAT integration (plan.md item 14, V1–V10)

- Date: 2026-11-06 (host clock).
- HEAD verified: `4cb8eff86590950e26800e86aa7946a3a26f4fac` (`docs: ADR 0001 DynamoDB persistence and persistence-driver guide`), on top of FEAT-001..005 (`eb6d0f2`, `5842c2b`, `86d581a`, `23811d0`, `5628ec6`, `72b6487`, `4cb8eff`).
- Result: every V-step met its expectation. No seam between features needed a fix, so this iteration made **no commit**.
- **DynamoDB Local WAS exercised**: Docker server 29.8.0, `amazon/dynamodb-local:2.5.2` on `127.0.0.1:8000`. The container was stopped at the end.

### V1 Build
`Set-Location "<wt>"; npm run build` → **exit 0**. Shared, backend (`tsc` + `[copy-assets] migrations copied to dist`) and frontend (`tsc -b && vite build`, `built in 5.26s`) all built. The vite chunk-size warning (973.74 kB) is cosmetic and was already there. Output: `.tmp\verify\it1-v1-build.txt`.

### V2 Default tests (DYNAMODB_ENDPOINT removed)
`npm test 2>&1 | Tee-Object .tmp\verify\npm-test-default.txt` → **exit 0**.
- `Test Files 22 passed | 1 skipped (23)`
- `Tests 260 passed | 80 skipped (340)`: total 340, passed 260, skipped 80.
- The 80 skipped tests are all DynamoDB opt-in blocks: contract `[dynamodb]` 69, `dynamoOnly` 3, the seed DynamoDB block 2 and the migrate opt-in block 6.

Verbose run (`packages\backend`: `npx vitest run --reporter=verbose`, exit 0, `.tmp\verify\it1-v2-verbose.txt`). Passing tests by file:

| File | Passed | Note |
|---|---|---|
| integrations/live/HttpUrbaniLogsAdapter.test.ts | 13 | pre-existing |
| services/alertService.test.ts | 12 | pre-existing |
| integrations/live/HttpUrbaniAlertsAdapter.test.ts | 8 | pre-existing |
| repositories/alertCorrelation.test.ts | 5 | pre-existing |
| integrations/live/HttpUrbaniChatProvider.test.ts | 8 | pre-existing |
| integrations/ai/MockAIProvider.test.ts | 4 | pre-existing |
| lib/markdown.test.ts | 8 | pre-existing |
| integrations/live/logLineParser.test.ts | 6 | pre-existing |
| services/chatService.test.ts | 1 | pre-existing |
| integrations/index.test.ts | 4 | pre-existing |
| services/authService.test.ts | 4 | pre-existing |
| **pre-existing subtotal** | **73** | unchanged from the baseline |
| repositories/repositories.contract.test.ts | 69 | `[sqlite]`: 69 distinct C- ids (`[dynamodb]` 69 skipped) |
| routes/routes.test.ts | 27 | 27 route steps |
| db/cli.test.ts | 19 | |
| repositories/common.test.ts | 17 | |
| repositories/dynamodb/commands.test.ts | 26 | |
| repositories/dynamodb/items.test.ts | 9 | |
| db/seed.test.ts | 6 | 2 skipped (DynamoDB block) |
| config/index.test.ts | 5 | |
| repositories/index.test.ts | 4 | |
| db/migrateSqliteToDynamo.test.ts | 3 | 6 skipped (opt-in) |
| db/migrations.test.ts | 2 | |
| repositories/dynamodb/dynamoOnly.test.ts | 0 | 3 skipped (whole file) |
| **total passed** | **260** | |

### V3 Static gates (run from `packages\backend\src`)
- a (AC5, no `db/connection`, `better-sqlite3` or `@aws-sdk/` imports outside repositories/db/test): no output.
- b (AC19, `QueryCommand|BatchGetCommand|BatchWriteCommand` outside `repositories\dynamodb\ops.ts`): no output. The gate is live: the pattern has 10 hits in total, all of them in `ops.ts`.
- c (AC18, `new RegExp|RegExp(` under `repositories\`): no output.
- d (AC6, un-awaited `repos.x.y(` in services, routes, integrations\mock and db): no output. `server.ts`: line 5 imports `getRepositories, assertDynamoReachable`, line 17 `const repos = getRepositories();`, line 21 `await assertDynamoReachable(repos);`.
  - Hand review: every `repos`/`getRepositories` line outside `repositories/` and `test/` that lacks `await` is an import, a `const repos = getRepositories()` or a `repos.driver` read. The three `MockDynamoDBAdapter` calls, the `apiRoutes.ts:170` `audit.query` call and the `healthRoutes.ts:30` `health.ping` call are all awaited.
- e (`git -C "<wt>" diff --stat 5cc5ffa -- packages/frontend`): empty.

### V4 Frontend
`Set-Location "<wt>\packages\frontend"; npx tsc -b --noEmit` → **exit 0**, no output.

### V5 Infra (no CDK CLI)
`Set-Location "<wt>\infra"; npm ci; npx tsc --noEmit; npm run check` → **ci=0, tsc=0, check=0**.
- `npm ci` reports 3 vulnerabilities (2 moderate, 1 high) in the existing lockfile. The lockfile was not changed.
- `npm run check` prints `app-table check passed: UrbaniApp table (PK/SK, GSI1, CMK, PITR, Retain), UrbaniAlerts unchanged, UrbaniDashboardTaskRole (ecs-tasks + aws:SourceAccount, 2 statements, no Scan), backend DB_DRIVER=sqlite`. The cfn-validate W2531 warnings (nodejs20.x runtime on the existing placeholder Lambdas) are cosmetic and were already there. Synth output goes to `%LOCALAPPDATA%\Temp\cdk.out*`.

### V6 SQLite smoke on port 4100
`powershell -NoProfile -ExecutionPolicy Bypass -File "<wt>\.tmp\smoke\smoke.ps1" -Driver sqlite -Name sqlite -Seed -Baseline "<wt>\.tmp\smoke\baseline\keysets.json" -CheckDriverLine` → **exit 0**.
- Seed: migrations `001_initial_schema` and `002_dpi2_persistence_foundation` applied, then `Seeded bootstrap admin user` and `Seed complete` (services 4, alerts 3, logs 60, metrics 24).
- Driver line: `Persistence driver: sqlite`, path `C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\sqlite\urbani.sqlite`.
- All 27 steps returned 200, except 404 at 09 and 14 as expected. Step 02 (ready) returned 200. Login (03), alerts (07), logs (10), audit (19/26) and settings (17/25) were all exercised. The capture printed `Baseline comparison: all 27 steps match`.
- After the run the server was stopped, port 4100 was free, and `Get-NetTCPConnection -LocalPort 4100 -State Listen` printed nothing.

### V7 AWS pre-flight
`(Test-Path "$HOME\.aws\credentials") -or (Test-Path "$HOME\.aws\config")` → `False`. The `AWS_*` credential variable listing printed no names. No cache file was opened.

### V8 DynamoDB Local (exercised)
1. `docker version --format '{{.Server.Version}}'` → `29.8.0`.
2. `docker run -d --rm --name urbani-dynamodb-local -p 127.0.0.1:8000:8000 amazon/dynamodb-local:2.5.2 -jar DynamoDBLocal.jar -sharedDb -inMemory` → container `81df8d9212a0`, `ready=True` (`CorsParams`), ports `127.0.0.1:8000->8000/tcp`.
3. `$env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm test` → **exit 0**: `Test Files 23 passed (23)`, `Tests 340 passed (340)`, 0 skipped, 47.08 s.
   - `repositories.contract.test.ts` ran 138 tests = 69 `[sqlite]` + 69 `[dynamodb]`, all passed.
   - The other opt-in tests also passed: `dynamoOnly` 3/3, `migrateSqliteToDynamo` 9/9, `seed` 8/8 (the DynamoDB block: "loads the mockData counts" and "is idempotent").
   - Output: `.tmp\verify\it1-npm-test-dynamodb.txt`. A first attempt piped through `Select-String` and was cut off by the shell tool's silence timeout. It held a lock on `npm-test-dynamodb.txt`, so the run was repeated with streamed output into a new file.
4. ENV-DYNAMO(`UrbaniSmoke`):
   - `npm run dynamo:tables` → exit 0, `Table UrbaniSmokeApp at http://127.0.0.1:8000: created`.
   - `npm run seed` ×2 → exit 0 and 0. Both runs log `Persistence driver: dynamodb` with `"table":"UrbaniSmokeApp","region":"us-east-1","endpoint":"http://127.0.0.1:8000"`. The second run logs `Admin user already exists; skipping`. Both log `Seed complete` (services 4, alerts 3, logs 60, metrics 24).
   - Tripwire `.tmp\smoke\dynamo-unused\urbani.sqlite`: `False`.
5. ENV-DYNAMO(`UrbaniMigrate`):
   - `npm run dynamo:tables` → exit 0, `created`.
   - `npm run dynamo:migrate -- --source "<wt>\.tmp\smoke\sqlite\urbani.sqlite" --dry-run` ×2 → exit 0 and 0. Both runs print `Source (read-only): C:\Antigravity\Urbani DPI\.worktrees\dpi2\.tmp\smoke\sqlite\urbani.sqlite` and the same counts: TOTAL source 115, wouldCreate 115, wouldSkip 0, failed 0. Per entity: roles 2, users 1, preferences 0, environments 1, services 4, alerts 4, logs 60, metrics 24, aiAnalyses 2, usage 7, audit 6, integrations 4, chat* 0.
   - Real run → exit 0: created 115, skipped 0, failed 0.
   - Re-run → exit 0: created 0, skipped 115, failed 0.
   - Tripwire: `False`.
6. `smoke.ps1 -Driver dynamodb -Name dynamodb -Prefix UrbaniSmoke -Baseline <keysets> -CheckDriverLine` → **exit 0**.
   - Driver line OK: `"endpoint":"http://127.0.0.1:8000"`, table `UrbaniSmokeApp`.
   - The capture printed `Baseline comparison: all 27 steps match`. Port 4100 was free afterwards.
   - SQLite / DynamoDB totals: **alerts 3 / 3, services 4 / 4, usage 7 / 7**.
   - Extra body comparison of the SQLite and DynamoDB smoke outputs: 15 of 27 bodies are byte-identical. The others differ only in generated ids and timestamps (auth/me, audit, analyses, acknowledge, 404 correlation ids), with one more difference in steps 06 and 11. There, metric snapshots with equal timestamps come back in a different order (SQLite `metric-svc-main-0` first, DynamoDB `metric-svc-payments-0` first). Both bodies hold the same set of lines. Design §2.1 item 6 says the order of ties under `ORDER BY timestamp DESC` is unspecified. Design §5 has the DynamoDB driver break ties by id, and the risk table lists tie order as an accepted divergence that the contract keeps out of its assertions. Nothing was changed.
7. `docker stop urbani-dynamodb-local` → exit 0. `docker ps -a --filter name=urbani-dynamodb-local -q` printed nothing. Tripwire: `False`. A TCP connect to 127.0.0.1:8000 was refused.

### V9 Guards (each a fresh call starting with ENV-GUARD)
| Command | Exit | Message |
|---|---|---|
| `npm run dynamo:tables` | **2** | `Refusing: dynamo:tables only targets DynamoDB Local (set DYNAMODB_ENDPOINT). Cloud tables come from infra/ (CDK).` |
| `npm run dynamo:migrate -- --source "<wt>\.tmp\smoke\sqlite\urbani.sqlite"` | **2** | `Source (read-only): …`, then `Refusing: dynamo:migrate would target AWS DynamoDB. Pass --allow-aws, or set DYNAMODB_ENDPOINT for DynamoDB Local.` |
| `$env:DYNAMODB_ENDPOINT='ftp://x'; npm run dynamo:migrate -- --source …` | **2** | `Invalid environment configuration: - DYNAMODB_ENDPOINT: must be an http(s) URL` |
| `$env:DB_DRIVER='dynamodb'; npm run seed` | **2** | `Refusing: seeding an AWS DynamoDB table needs --allow-aws (set DYNAMODB_ENDPOINT for DynamoDB Local)` |
| `$env:DB_DRIVER='dynamodb'; npm run reset --workspace @urbani/backend` | **1** | ``reset is SQLite-only. For DynamoDB Local run `npm run dynamo:tables -- --reset` `` |

`Test-Path "<wt>\.tmp\smoke\guard\unused.sqlite"` → `False`.

The first two `npm run dynamo:tables` attempts were cut off by the shell tool's silence timeout before npm returned. The compiled CLI (`node packages/backend/dist/db/cli.js tables`) printed the refusal at once. The npm form was then run under `cmd /d /c` with output redirected, and it gave exit 2 with the same message (`.tmp\verify\v9a-npm.out/.err`).

### V10 Hygiene
- `git -C "<wt>" status --short`: empty, so no `.env`, `.tmp/` or `packages/backend/data/*` entries. The new `infra/node_modules` from V5 is ignored.
- `git -C "<wt>" diff 5c81908 -- .gitignore`: only `+.tmp/`.
- `Get-NetTCPConnection -LocalPort 4100,8000 -State Listen`: nothing. No `urbani-dynamodb-local` container exists, and no node process is running.
- `git -C "C:\Antigravity\Urbani DPI" rev-parse main` → `5cc5ffa05d41f47c61dc6d5c423bda51cc11b188` (unchanged).
- `git -C "C:\Antigravity\Urbani DPI" status --short --untracked-files=no` → ` M .gitignore`. **Deviation from the expected "nothing", not caused by this workflow.** FEAT-001 first recorded it: another actor removed the `.env` line from the main workspace's `.gitignore` on 2026-11-05 16:02. Every step since has left it untouched, and this step did not touch it either. The user should decide whether that edit is intended. Without the rule, a `.env` holding secrets could be committed in the main workspace.
- `git -C "<wt>" branch --show-current` → `dpi2`. `@{u}` → `fatal: no upstream configured for branch 'dpi2'`, so nothing was pushed. `git worktree list` shows both worktrees (`5cc5ffa [main]`, `4cb8eff [dpi2]`).

### Commits this iteration
None. No seam fix was needed, and verification.md is outside the repository.
