# Code review: DPI 2 item 1 (persistence foundation), pass 1

**Verdict: APPROVED.** No blockers found.

Reviewed: `git -C "<wt>" diff 5c81908..HEAD` (7 commits, `eb6d0f2`..`4cb8eff`, 96 files) against requirements.md Rev 3, design.md Rev 3, design-verdict.json findings 30–34, plan.md, verification.md, FEAT-001..005 and the commit messages. Suites were not re-run. The only commands run were read-only greps and `git` reads.

## Evidence by requirement area

- **FR1 async layer and boundary.** `repositories/types.ts` matches design §3.2 verbatim. The registry (`repositories/index.ts`) follows §3.3, including `assertDynamoReachable`. I listed every `repos.`/`getRepositories()` call outside `repositories/` and `test/`, and every caller of the 13 service methods that became async. All of them are awaited, so there are no floating promises (AC6). The AC5, AC18 and AC19 gates were re-run from `packages/backend/src` and printed nothing.
- **FR2 SQLite parity.** The six repositories moved with `git mv`. Their SQL and `db.transaction` bodies are unchanged, apart from `ctx.now()`, `countAll`, the absorbed seed statements (identical SQL), and `upsertUser`'s `ON CONFLICT(id)` statement (§4.3, FR2.5). Methods have no internal `await`, so each stays atomic. Migration 002 matches §4.4 verbatim. `routes.baseline.json` was committed in `eb6d0f2` before any source change and has not changed since. `routes.test.ts` replays all 27 steps against it. `UserRow.role` never reaches a response: `toAuthUser` builds `AuthUser` explicitly.
- **FR3 new capabilities.** `validation.ts` implements every §7.3 row and the three cursor schemas. The audit range check runs before any query on both drivers. `chatService.ts:89` passes `'FAILURE'` on the failure path.
- **FR4 DynamoDB driver.**
  - `upsertUser` (`dynamodb/userRepository.ts:160-236`) matches the §5.4 decision table row by row.
  - The live upsert (`alertRepository.ts:50-74`) builds its SET list from `alertItem` and appends `if_not_exists(#status, :open)`.
  - Every update that mirrors a SQL `UPDATE` carries `attribute_exists(#pk)`, and `removeAlertLink` is conditioned on `#alertId = :id`.
  - Every base-table Get, Query and BatchGet sets `ConsistentRead: true` (checked by grepping every Get and Query). No GSI query sets it.
  - The key guard has the lower bound 1 (`keys.ts:47,53`). The 16 builders set `entityType`, and the three create-capable UpdateItems SET `#entityType`.
  - Dummy credentials are used only when an endpoint is set, and `throwOnRequestTimeout` is on (`client.ts:29-31`).
  - SDK 3.1162.0 needs Node ≥ 20, which matches the `node:20` image. The only change to existing lockfile entries is `tslib` losing `"dev": true`, which is expected because the SDK depends on it.
- **FR5 tests.** The contract defines all 69 `C-` ids, and C-KY-01 includes the `''` lookups. Edits to the 4 pre-existing test files are limited to async/await, registry access and the FR5.4 type-only edit. No assertion was removed or weakened. Every opt-in file builds its own `UrbaniTest<runId>App` harness with a 20 s timeout.
- **FR6/FR7 tooling.**
  - `db/cli.ts` value-imports only `./cliErrors` and `../lib/errors`, and loads config through `await import()`.
  - `runMigrate` checks its preconditions in the §10 order. The AWS guard (`:636`) runs before the read-only open (`:640`) and before any client exists. The [F32] mapping is in `:653` and in `cli.ts:59`.
  - The `reset.ts:15` and `migrate.ts:63` guards run before `getDb()`. The seed guard runs first and exits 2 (`seed.ts:147-154`).
- **FR8 IaC.** The constructs match §11. `app-table.check.ts` asserts exactly two statements on the role, no managed or inline policies, `TaskRoleArn`, and `DB_DRIVER=sqlite`. `deploy-ecs.sh`, `redeploy.sh` and `packages/frontend` have no diff.
- **FR9 docs.** The ADR covers the 14-part outline, including the "empty ids" divergence. `.env.example` has the new variables and the bash/PowerShell section. dotenv 16.6.1 strips the inline comment, so `DYNAMODB_ENDPOINT=` stays empty and is read as unset.
- **Findings 30–34 and P1.** All are implemented: LOG_LEVEL pinned (driver lines visible in V6/V8), the V7 pre-flight runs before V8 and V9, the [F32] exit codes, the exact [F33] refusal text and stray-token rejection with a stderr-spy test, [F34] in `keys.ts`, the builders, C-KY-01, `items.test.ts` and ADR §6, and `throwOnRequestTimeout`.

## Verification evidence (verification.md, FEAT files, commit messages)

All V1–V10 steps are recorded with exit codes, and they agree with the FEAT files and commit messages.
- Build: exit 0. Frontend `tsc -b`: 0. Infra `npm ci` / `tsc` / `check`: 0 / 0 / 0, without the CDK CLI.
- Default `npm test`: 260 passed and 80 skipped. The 80 skipped tests are all DynamoDB blocks. The 73 pre-existing tests pass with unchanged per-file counts, and `[sqlite]` passes 69 cases.
- DynamoDB Local was exercised:
  - opt-in suite 340/340 with 0 skipped, including contract `[dynamodb]` 69/69;
  - seed run twice;
  - migrate: dry run twice with 115 would-create, real run 115 created, re-run 115 skipped;
  - DynamoDB smoke 27/27 matches, with totals 3/3, 4/4 and 7/7;
  - the container was stopped.
- SQLite smoke on port 4100: 27/27. Guards exited 2/2/2/2/1 with the expected texts, and the tripwire files are absent.
- I re-checked hygiene read-only. No `.env`, `.tmp/` or `packages/backend/data/*` path is in the diff. The branch is `dpi2` with no upstream, the worktree is clean, and `main` is `5cc5ffa`.

## Notes (non-blocking)

1. AC17 (`item-01-report.md`, `BACKLOG.md`) is plan item 15, which comes after this gate. Neither file has been written yet.
2. The main workspace's `.gitignore` lost its `.env` line through another actor (recorded since FEAT-001). It is outside this item. The user should confirm whether that change is intended.
3. On DynamoDB, `PUT /api/settings` audits `Object.keys(req.body)` (`settingsService.ts:161`, JSON limit 1 MB in `app.ts:35`). A body whose keys serialize to more than 380 KiB therefore gets `ITEM_TOO_LARGE` (HTTP 500), where SQLite stores the event. This follows the approved §5.8 size policy, and DynamoDB is not enabled in this item, so it is not a blocker. Worth a line in item 14's go-live checklist.
4. Process: during this review I ran one read-only `git -C "C:\Antigravity\Urbani DPI" rev-parse main`, which resolves the same ref as `git -C "<wt>" rev-parse main`. Nothing was modified.
