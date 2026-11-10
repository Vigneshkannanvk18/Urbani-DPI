# DPI 2 item 1: Design review, Revision 3

Reviewed: `design.md` Revision 3 and `requirements.md` Revision 3 in this folder. This is a re-review. The 8 findings of the Revision 2 review (22–29) are re-checked first, and then the Revision 3 material is reviewed as new.

They were checked against:
- the worktree `C:\Antigravity\Urbani DPI\.worktrees\dpi2`, still clean at dpi2 HEAD `5c81908`, with `main` at `5cc5ffa`;
- the ground rules in `.agents/tasks/dpi2/BACKLOG.md`;
- backlog item 1 and §6 of `docs/DPI2_PLAN_AND_GAP_ANALYSIS.md`.

Method:
- **Re-grep.** I searched `packages/backend/src` for every repository import and call, and for every `getDb`, `better-sqlite3`, `db/connection` and `@aws-sdk` use. I also re-checked the §2.2 line numbers.
- **Files read.** Every file that the Revision 3 material depends on:
  - the routes, the services, the `errorHandler`, `rateLimit` and `auth` middleware;
  - `MockAIProvider`, `MockCloudWatchAdapter`, `HttpUrbaniAlertsAdapter` and `mockData`;
  - `seed.ts`, `connection.ts`, `migrate.ts`, `reset.ts`, `server.ts`, `test/setup.ts` and `test/testDb.ts`;
  - the four existing repository and service tests;
  - `vitest.config.ts`, the backend `tsconfig.json`, `Dockerfile` and `package.json`;
  - the infra constructs, `bin/app.ts` and `infra/config`;
  - `docker-compose.yml`, `.gitignore`, `.env.example` and `deploy-ecs.sh`.
- **Experiments**, in scratch folders under `%TEMP%` that were deleted afterwards:
  - the §4.3, §4.4 and §4.5 SQL, extracted from the Revision 3 text, run on in-memory SQLite;
  - the §4.5 `compileLike`, extracted from the Revision 3 text, cross-checked against `SELECT ? LIKE ?`;
  - `tsc` with the backend compiler options on a `src/test/` helper that imports `vitest`;
  - npm 11.6.2: `INIT_CWD` and argument forwarding through the nested root alias, including a path that contains a space.
- **Read-only Docker checks:** `docker version`, `docker compose config` on the worktree's compose file, and `docker manifest inspect amazon/dynamodb-local:2.5.2`, which is an anonymous Docker Hub query.
- **What I did not do.** I wrote nothing to the worktree, started no container and made no AWS call. I read no credential or token file; I listed the `~/.aws` file names only. I did not open `packages/backend/data/*`.

**Verdict: APPROVED.** All 8 Revision 2 findings are closed. Revision 3 introduces no HIGH or MEDIUM finding. Five NIT findings (30–34) remain, and they appear as `LOW` in `design-verdict.json`. Each is a small edit to the verification plan or to the key guard. None changes an interface, a key schema or an acceptance criterion.

## Revision 2 findings: re-check

| # | Sev. | Finding | Status | Evidence in Revision 3 |
|---|---|---|---|---|
| 22 | MEDIUM | `cli.test.ts` gets exit 1 where it expects 2 after `vi.resetModules()` | **Closed** | §8.3.1 re-imports `./cli` after every reset, using the snippet from the review, and never calls a `main` imported before the reset. §9.5 states that the `instanceof` mapping needs one module instance, and AC21 pins the pattern. The pure functions and `CliPreconditionError` are imported statically together, so they share one module graph. |
| 23 | MEDIUM | Item-creating writes omit `entityType` | **Closed** | The §5.4 rule names all 16 builders. The three create-capable UpdateItems SET `#entityType`, and `preferences.update` also SETs `#userId`. `emailLockItem` is used in `upsertUser` [1] and in the migration, and the live-upsert SET list is generated from `items.alertItem`. I enumerated every other UpdateItem in §5.3 and §5.4: `recordLogin`, `replaceDerivedEvidence`, `acknowledge`, `unlinkAll`, `clearAlertLinks`, `linkLogsToAlert` and the `appendMessage` session update. Each carries `attribute_exists(#pk)` or `#alertId = :id`, so none can create an item. The rule is tested by `items.test.ts`, `commands.test.ts` and C-PF-02, plus scan checks in `dynamoOnly.test.ts` and the migration test (FR4.11, AC20). |
| 24 | NIT | The readiness ping is eventually consistent | **Closed** | Row 46 says "strong", and §5.4 `health.ping` sets `ConsistentRead: true`. `commands.test.ts` asserts it (FR4.3). |
| 25 | NIT | §5.5 says transactions never run in parallel | **Closed** | §5.5 uses the corrected wording with both examples. |
| 26 | NIT | A relative `--source` resolves against `packages/backend` | **Closed** | `parseMigrateArgs` resolves against `INIT_CWD ?? cwd`. `runMigrate` prints `Source (read-only): …` before the file check, and `cli.test.ts` covers both. §12.2 and Appendix B use absolute paths. I re-ran the npm cases, and the §10 text matches them: the root alias resets `INIT_CWD` to the repository root even when the command is typed in a subfolder; a direct root script and `--workspace` keep the subfolder; the workspace script always runs in the package folder. |
| 27 | NIT | Opt-in DynamoDB tests share the configured table | **Closed** | §8.1 adds "One table per opt-in test file". The `seed.test.ts`, `dynamoOnly.test.ts` and migration-test rows each build their own `dynamoHarness` (FR5.3). |
| 28 | NIT | `routes.test.ts` leaves the request order open | **Closed** | §14 step 1 defines the 27-step table, the ids `A` and `N` carried between steps, and the key-set algorithm. The fixture is keyed by step id (AC7). I checked the sequence against the code (Verified assumptions). |
| 29 | NIT | Runtime files outside `.tmp/`, or the default database path | **Closed** | Adding `.tmp/` is the mandatory first action, checked with a probe file and `git check-ignore`. ENV-SQLITE and ENV-DYNAMO set `DATABASE_URL` under `.tmp\`, and the DynamoDB runs and the guards use a tripwire path. Finding 30 is a separate gap in the same environment sets. |

## New findings (Revision 3)

### 30. NIT: the inherited `LOG_LEVEL=error` hides the log lines that §14 steps 7.2, 8.4 and 8.6 check
**Where:** §14 "Runtime environments" (ENV-SQLITE, ENV-DYNAMO); steps 7.2, 8.4 and 8.6.

**Problem:** This workflow's shell environment exports `LOG_LEVEL=error`. It is set at process scope, not at User or Machine scope, so every fresh PowerShell process inherits it. Neither environment set pins `LOG_LEVEL`, and `lib/logger.ts` drops every entry below the threshold. These lines are all `info`:
- step 7.2: `Persistence driver: sqlite` with the `.tmp\smoke\sqlite\` path;
- step 8.4: `Admin user already exists; skipping`, and `Persistence driver: dynamodb` with `endpoint: http://127.0.0.1:8000`;
- step 8.6: the same endpoint line, which must be checked before any request is sent.

As written, these checks cannot be performed on this machine. No acceptance criterion depends on them. The step 8.6 check is a safety check, though, and an implementer who cannot see the line may skip it silently.

**Fix:** add `$env:LOG_LEVEL='info';` to ENV-SQLITE and ENV-DYNAMO. Add one sentence to the "Runtime environments" paragraph: "The sets override inherited values; this host exports `LOG_LEVEL=error`."

### 31. NIT: "This machine has no AWS credentials (verified by the review)" is a stale, second-hand claim
**Where:** §13, the risk row "On a machine with AWS credentials…"; §14 step 9, last paragraph.

**Problem:** The statement was true at the Revision 2 review. Since then `%USERPROFILE%\.aws\sso\cache\` has appeared. It holds six SSO token cache files, Kiro's own among them; I listed the names only. There is still no `config` or `credentials` file and no AWS credential variable in the environment, so the SDK default chain cannot resolve credentials today. But the host changes between runs, and the plan rests a secondary NFR1 safeguard on an observation made in an earlier review.

**Fix:** add a pre-flight step before steps 8 and 9:

```powershell
(Test-Path "$HOME\.aws\credentials") -or (Test-Path "$HOME\.aws\config")   # must print False
Get-ChildItem Env: | Where-Object Name -match '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|WEB_IDENTITY_TOKEN_FILE|CONTAINER_CREDENTIALS_)'   # must print nothing
```

If either check finds something, stop and report. Do not open the cache files. In both places, replace "(verified by the review)" with "(checked by the pre-flight step)".

### 32. NIT: the exit code of `dynamo:migrate` when DynamoDB Local is not reachable is ambiguous
**Where:** §10 precondition 6; §9.5, `main()` step 4; the `dynamo:migrate` rows of §7.2.

**Problem:** §10 says that each failed precondition exits 2. Precondition 6 reads "the target table answers `health.ping`, otherwise 'create the table first'". `ping` goes through `translateAwsError`, which gives two different results:
- a missing table becomes a fatal `PersistenceError`, which `main()` maps to 2;
- `ECONNREFUSED` (DynamoDB Local not running) becomes a non-fatal `UNAVAILABLE`, which `main()` maps to 1, unless `runMigrate` wraps it.

§7.2 lists only "table missing (fatal)" under exit 2 for `dynamo:migrate`, and it gives `dynamo:tables` exit 1 for `ECONNREFUSED`. Both readings are valid. "Create the table first" is also the wrong hint when Local is down.

**Fix (chosen, to match `dynamo:tables`):** precondition 6 becomes: "A fatal `PersistenceError` (table missing, access denied) exits 2 with 'create the table first (`npm run dynamo:tables`)' or the access hint. A non-fatal `UNAVAILABLE` (DynamoDB not reachable) exits 1 with 'DynamoDB not reachable at <endpoint>'." Add the second case as a `dynamo:migrate` row in §7.2.

### 33. NIT: the step 9 migrate guard can pass for the wrong reason, because `<wt>` contains a space and the refusal message is undefined
**Where:** §14 steps 8.5 and 9 (`--source <wt>\.tmp\smoke\sqlite\urbani.sqlite`); §10 precondition 4; §7.3 "CLI flags".

**Problem:** `<wt>` is `C:\Antigravity\Urbani DPI\.worktrees\dpi2`, and the commands do not quote it. Pasted unquoted into PowerShell, the path becomes two arguments. Then either `parseMigrateArgs` rejects the stray token, or `--source C:\Antigravity\Urbani` fails the file check. Both exit 2, so the AC11 guard ("`dynamo:migrate` without `DYNAMODB_ENDPOINT` and without `--allow-aws` exits 2") passes without reaching the AWS guard.

Nothing in the plan would catch this:
- step 9 does not say which message to expect;
- §9.3 and §9.5 define the refusal texts for the seed and for `dynamo:tables`, but §10 defines none for `dynamo:migrate`;
- §7.3 does not say whether a positional token is an error.

I checked with npm 11.6.2 that a quoted path containing a space reaches the workspace script as one argument through the nested root alias, so quoting is enough. The same applies to step 1.1's `git -C <wt> …`, which fails loudly when unquoted.

**Fix:**
1. Quote every `<wt>` path in §14, for example `--source "<wt>\.tmp\smoke\sqlite\urbani.sqlite"`.
2. Define the precondition-4 message: `Refusing: dynamo:migrate would target AWS DynamoDB. Pass --allow-aws, or set DYNAMODB_ENDPOINT for DynamoDB Local.`
3. Step 9 checks that message as well as exit code 2. The matching `cli.test.ts` case asserts it with a `process.stderr.write` spy, because `logger.error` writes to stderr.
4. In §7.3, state that any token that is neither a known flag nor the value of `--source` is a usage error (exit 2).

### 34. NIT: the key guard checks only the upper byte limits, but a live path produces empty keys
**Where:** §5.4 "Key-size guard" (`keys.fitsKey` and the builder checks); §2.5 accepted divergences ("Key length"); §5.10; C-KY-01; FR4.9.

**Problem:** The guard checks only the upper limits: 2,048 bytes for a partition key and 1,024 for a sort key. DynamoDB also rejects an empty string in any table or index key attribute, with a `ValidationException`.

One live path produces such a key. `HttpUrbaniAlertsAdapter.mapOne` (line 198) maps a missing or empty upstream `alert_id` to `''`, because `str()` (line 259) returns `undefined` for empty strings. `urbaniIncidentAlertSchema.alertId` is `z.string()` with no minimum, so the alert passes validation and reaches `upsertLivePreservingStatus` with `SK = ''` and `GSI1SK = ''`.
- **SQLite** stores the alert.
- **DynamoDB** raises a `ValidationException`. It falls into §5.10's row "any other `ValidationException` (a bug in an expression)", so it is logged as an expression bug, and it aborts every `syncLiveAlerts` at that alert. §5.8 rejects exactly this failure mode for oversized evidence.

Lookups by `''` cannot be reached over HTTP, because Express route parameters are never empty. A direct call would return HTTP 500 where SQLite returns `null`.

**Fix:**
1. The guard checks `1 <= utf8Bytes <= limit` for every key part, in `fitsKey` and in the builders. An empty key then behaves like an over-long one: a lookup returns its not-found result without a call, and a write raises `INVALID_ARGUMENT`.
2. List "empty ids" next to "Key length" in §2.5's accepted divergences and in ADR §7. State the consequence: an upstream alert without an id aborts the DynamoDB live sync at that alert, as an over-long id already does.
3. Add `''` to the C-KY-01 lookups. Leave out `audit.query({ actor: '' })`, because the truthiness rule (§2.5-5) already treats an empty actor as no filter. Add an `items.test.ts` case in which a builder given an empty id throws `INVALID_ARGUMENT`.

Skipping id-less upstream alerts in the adapter would be a service change, so that decision belongs to a later item.

## Checklist results

| Check requested | Result |
|---|---|
| Every repository function and caller is inventoried | **Pass.** The re-grep matches every §2.1 and §2.2 entry. That includes the `ReturnType` uses at `alertService.ts:211` and `dashboardService.ts:38` and the three type-only `better-sqlite3` imports. No other file under `src/` imports a repository, `db/connection`, `better-sqlite3` or `@aws-sdk`. |
| The interfaces cover every function callers use | **Pass.** Every call in the services, routes, seed, mock adapter, health route, server and tests maps to a `Repositories` method. |
| Sync better-sqlite3 transactions have an async plan that keeps atomicity | **Pass.** The 6 `db.transaction` sites are unchanged. Every SQLite method, old and new, runs its whole body without an internal `await`. |
| The access-pattern table covers every service query, with a key or GSI and no Scan on hot paths | **Pass.** Rows 1–47; Scan appears only in the test harness. Finding 34 is a key-validation gap, not a missing pattern. |
| Conditional writes cover unique email, idempotent upserts and acknowledge-status preservation | **Pass.** These mechanisms are unchanged from Revision 2. The Revision 2 review traced the email-lock decision table. |
| `deleteByDataSource` and alert↔log links work in DynamoDB | **Pass.** |
| `users.role` defaults existing users to Super Admin | **Pass.** Re-run on the Revision 3 SQL (Verified assumptions). |
| Audit is queryable by time range and by user | **Pass.** The keyset SQL was re-run. The `AUDIT` sort key covers time ranges, and `ACTOR#` in GSI1 covers queries by user. |
| Chat sessions, messages, feedback and preferences are covered | **Pass.** Preferences and feedback items now carry `entityType`, and preferences items also carry `userId`. |
| Contract tests skip DynamoDB unless `DYNAMODB_ENDPOINT` is set | **Pass.** |
| IaC follows the existing table's conventions, with least-privilege grants | **Pass.** CMK, PITR, RETAIN and on-demand billing. The task role gets 8 data-plane actions on the table and `GSI1`, and KMS through `kms:ViaService`. No other statement lands on the role (Verified assumptions). |
| Nothing requires AWS calls, deploys, a merge to `main`, or touching `packages/backend/data` | **Pass for the design.** Findings 31 and 33 tighten two NFR1 checks in the verification plan. |
| UNVERIFIED assumptions are resolved or harmless | **Pass.** Two are now verified (§15.3 and §15.4), and one is moot (§15.9). |

## Verified assumptions
- **Repository state.** The worktree is clean at `5c81908` on `dpi2`, and `main` is at `5cc5ffa`.
- **Caller inventory.** All §2.2 line numbers match:
  - `apiRoutes.ts`: 32, 36, 93, 100, 104, 111, 116, 158, 159, 170, 180 and 184;
  - `seed.ts`: 35, 36, 40, 47, 56, 59, 101 and 182;
  - `healthRoutes.ts:30` and `server.ts:15`.

  `alertCorrelation.test.ts` imports `better-sqlite3` (line 3) and `db/connection` (line 7) from inside `repositories/`, which AC5 allows.
- **SQL from the Revision 3 text**, extracted and run on in-memory SQLite 3.49.2 with better-sqlite3 11.10:
  - **Migration 002** on a populated 001 database. The existing user's role is `SUPER_ADMIN`. The audit results are `FAILURE`, `SUCCESS` and `SUCCESS`, and a row with malformed JSON gets `SUCCESS` without aborting the migration. The 4 new tables exist, and the CHECK rejects `BOGUS` (`SQLITE_CONSTRAINT_CHECK`).
  - **`upsertUser`.** A new user defaults to `SUPER_ADMIN`, and an upsert that omits the role keeps `QA_OPERATOR`. A duplicate email raises `SQLITE_CONSTRAINT_UNIQUE`, and the other user stays intact.
  - **DPI 1's `INSERT OR REPLACE INTO users`** on the migrated database resets the role to `SUPER_ADMIN` and keeps the preferences row.
  - **The `listByTimeRange` keyset clause** returns `e2, e1` for the cursor `(ts, 'e3')` over four rows that share one timestamp.
- **`compileLike` from the Revision 3 text.** 30,000 pseudo-random pairs gave 0 mismatches against `SELECT ? LIKE ?`. The alphabet covered:
  - ASCII letters in both cases, and `é`/`É`, `ß`, `İ` and the Kelvin sign;
  - an emoji;
  - `%`, `_`, `.`, `*`, `(`, `[`, space and `-`.

  The AC18 timing case returned `false` in 0.020 ms.
- **The §14 step 1 sequence matches the code:**
  - `svc-main` exists in `mockData.ts`. `analyzeSchema` and `chatSchema` accept the given bodies, and `PUT /settings` accepts any body.
  - Logout returns 200 with `{ ok: true }`. `/ready` returns exactly `{ status, checks: { database } }`.
  - `alertService.get` throws before `record`, so step 09 writes no audit event. Across steps 04–18 the only write is step 08's `ALERT_VIEWED`. Step 19 therefore holds `LOGIN` and `ALERT_VIEWED`, both without metadata.
  - Chat and settings add the metadata keys `questionChars`, `logsSource` and `requestedKeys`.
  - The seed creates no AI analyses, so step 18 returns an empty list.
  - The mock providers are deterministic, and the sequence stays under the login limiter (10 per minute) and the chat limiter (30 per minute).
- **No response key depends on `NODE_ENV`.**
  - `config.env` appears only as a value: `/health` `env` and settings `general.environment`.
  - `isProd` gates only the seed and reset guards and the HSTS header.
  - `errorHandler` emits the same keys in every mode.
- **`routes.test.ts` mechanics.** `seed()` is exported, and `closeDb()` sits in its CLI block, so the test can seed the in-memory database. `getDb()` creates the parent folder, so a `.tmp\smoke\<db>\` folder need not exist beforehand.
- **Live-upsert parity.** SQLite's `upsertLivePreservingStatus` sets `created_at` to the current time on every call, so `#createdAt = :now` matches it. Every `UrbaniIncidentAlert` field is required, and `confidence` is `nullable()`.
- **`src/test/*.ts` in the build.** The backend `tsconfig.json` compiles `src/test/**`, because it excludes only `*.test.ts`.
  - **Type check.** I ran `tsc` with the same options on a helper that imports `describe`, `it`, `expect` and `vi` from `vitest`. It exited 0, with `vitest` resolved to `dist/index.d.ts` under `moduleResolution: Node`.
  - **Docker image.** The Dockerfile's build stage runs `npm ci` with dev dependencies before it builds, and prunes afterwards.

  So `repositoryContract.ts` breaks neither `npm run build` nor the image build.
- **vitest configuration.** `fileParallelism: false`, `include: ['src/**/*.test.ts']` and `setupFiles: ['src/test/setup.ts']`. `test/setup.ts` assigns its variables directly, so shell values cannot override them.
- **npm 11.6.2, in a scratch project:**
  - **`INIT_CWD`.** Through the nested root alias it is the repository root, even when the command is typed in a subfolder. A direct root script and `--workspace`, typed in a subfolder, keep the subfolder.
  - **Arguments.** A quoted path that contains a space reaches the workspace script as one argument through the nested alias.
- **Docker.** The Docker Desktop 4.92.0 engine (29.8.0) is now reachable, unlike on 2026-10-28 (§2.6). That makes AC10 achievable.
  - `amazon/dynamodb-local:2.5.2` exists on Docker Hub as a multi-arch index (amd64 and arm64).
  - `docker compose config` on the worktree's compose file fails without `JWT_SECRET` ("required variable JWT_SECRET is missing a value"). The documented `JWT_SECRET=dev` prefix is therefore needed.
  - Ports 4100 and 8000 are free.
- **Infra.**
  - **Task role.** `DashboardConstruct` creates no task role and sets no `enableExecuteCommand`, and the `awsLogs` grants go to the execution role. The two FR8.2 statements will therefore be the only statements on the new task role.
  - **Stack environment.** `bin/app.ts` passes an `env`, but the check builds its own env-agnostic stack.
  - **Dependencies.** The lockfile pins `aws-cdk-lib` 2.271.0, `aws-cdk` 2.1143.0 and `ts-node` 10.9.2. `infra/node_modules` is still absent.
  - **`deploy-ecs.sh`.** It uses `us-east-1` (line 12) and `urbaniqa-dpi-task-role` (134). It probes `/health` (259), mounts `host: {}` (300) and passes `--enable-execute-command` (389).
- **Host environment.**
  - There is no `.env` in the worktree.
  - `LOG_LEVEL=error` and `JWT_SECRET` are inherited at process scope (finding 30).
  - `~/.aws` contains only `sso\cache\`, and no AWS credential variable is set (finding 31).
- **Live alert ids.** `HttpUrbaniAlertsAdapter.mapOne` maps a missing or empty upstream `alert_id` to `''`, and the shared schema accepts `''` (finding 34).
- **Plan alignment.** Plan item 1 asks for:
  - users and preferences, audit, chat history and feedback, and optionally alerts;
  - removal of the single-writer constraint;
  - seeding of the admin.

  The design covers all of these. It defers the deployment switch to item 14, as BACKLOG item 14 states. The §6 client inputs it depends on (account and region, retention, PII) appear in Appendix B or in the out-of-scope list. The work stays within ground rules 1–7: it uses the worktree only, makes no AWS change, ships a `WAITING_FOR_INTEGRATION`-style default (`DB_DRIVER=sqlite`), and uses ports 4100 and 8000 with `.tmp/` databases.

## Unverified or wrong assumptions

**Wrong or stale:**
- §13 and §14 step 9 say that this machine has no AWS credentials, "verified by the review". It now has an SSO token cache, although the default chain still has nothing it can use (finding 31).
- §14 treats ENV-SQLITE and ENV-DYNAMO as complete, but they inherit `LOG_LEVEL=error` from this host (finding 30).
- §5.4 treats the key guard as complete with upper bounds only, but a live path produces empty keys (finding 34).
- §2.6 and the §13 risk "no Docker engine" are out of date: the engine now runs. This is not a finding. It means DynamoDB Local can be exercised for AC10.

**Unverified, assessed (design §15):**
1. KMS permissions on the caller, and the need for `kms:DescribeKey`: harmless. They are checked at go-live, with a one-line fallback.
2. `requestHandler` as a plain options object: harmless; the fallback is defined.
3. The image tag `amazon/dynamodb-local:2.5.2`: **verified**. The Docker Hub manifest exists.
4. Compose failing on `${JWT_SECRET:?}`: **verified true**. The documented commands set it.
5. DynamoDB Local updating GSIs synchronously: harmless, with a bounded retry as the fallback. Not run.
6. The access key id `local`: harmless, because it is letters only.
7. `Template.fromStack` on the env-agnostic stack: likely to work, since there are no lookups and no bundling, and the assets exist. The dummy-`env` fallback is sound. Not run, because `infra/node_modules` is absent.
8. Real evidence sizes: harmless, given the 256 KiB budget and the warning log.
9. Starting Docker Desktop non-interactively: **moot**, because the engine is already running.
10. DynamoDB Local reporting `CancellationReasons` for every item: harmless. The decision table terminates either way.
11. The jar URL and the Java version: harmless, and moot while Docker works.
- Appendix B step 5.1, `ssmmessages:*` for ECS Exec: a go-live concern, harmless now.

**This review's own unverified claims:**
- That DynamoDB rejects empty-string values in table and GSI key attributes (finding 34) comes from the AWS documentation, not from a run against an engine.
- Whether the implementation step inherits the same `LOG_LEVEL` depends on that step's host environment. I observed it in this step's shell.
