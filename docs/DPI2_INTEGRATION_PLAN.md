# Plan: integrating branch `dpi2` into `main` after client approval

Nothing here has been executed. `main` is still the deployable DPI 1 build and must stay so until the client approves DPI 2. Facts below were read from git when this plan was written (branch `dpi2`, 21 item commits plus the item 14 commits on top of `main` at `5cc5ffa`).

## 1. State of the two branches

- `main` has **no commits that `dpi2` lacks** (`git log dpi2..main` is empty): `dpi2` was branched from the current `main` tip. A fast-forward is technically possible today.
- The `main` checkout is **dirty**: `.gitignore` is modified (adds `**/.env`) and there are untracked files that belong to the planning work (`docs/DPI2_PLAN_AND_GAP_ANALYSIS.md`, `docs/DPI2_CLIENT_QUESTIONS.md`, `docs/iam/`, `scripts/gen-dpi2-docs.js`, `OUTPUT/Urbani_DPI2_Plan.pdf`, the client source documents, `.agents/`). A merge into that checkout would stop on the `.gitignore` change.
- `deploy-ecs.sh` and `redeploy.sh` are identical on both branches. DPI 2 adds new, differently named scripts and does not touch them.
- Tracked stale files `packages/backend/data/*-wal` and `*-shm` exist on both branches (item 1 follow-up): remove them from the index in a separate commit.

## 2. Expected conflicts and surprises

If `main` gains commits between now and the merge (new docs, the diagram generator, `.gitignore` entries, hotfixes to the deploy scripts), expect conflicts in:

| Area | Why | Resolution |
|---|---|---|
| `.gitignore` | `dpi2` adds entries (load results, `deploy/dpi2.env`, `deploy/*.generated.json`); `main` has an uncommitted `**/.env` | Keep both; union of lines |
| `docs/` (guide, diagram docs) | `dpi2` appends section 11 to `AWS_DEPLOYMENT_GUIDE.md` and adds many files; `main` may edit the same guide | Keep `main`'s edits above section 11, `dpi2`'s section 11 and its runbook pointer |
| `scripts/gen-diagram*.js`, `OUTPUT/*` | Diagram generator work happens on `main` | Take `main`'s versions; `dpi2` does not edit them |
| `deploy-ecs.sh`, `redeploy.sh` | Any DPI 1 hotfix on `main` | Take `main`'s versions; `dpi2` never edits them |
| `package.json` / lockfile | `dpi2` adds scripts (`check:deploy`, ...) and the AWS SDK clients | Merge JSON by hand; regenerate the lockfile with `npm install` |
| `packages/backend/src/server.ts`, `config/index.ts` | A DPI 1 hotfix (for example the keep-alive fix) already exists in `dpi2` | Take `dpi2` |

## 3. Recommended strategy

1. **Freeze DPI 1.** Tag the live code: `git tag dpi1-live 5cc5ffa` and create `release/dpi1` from it for DPI 1 hotfixes while both versions run. After the merge, **do not run `redeploy.sh` from `main`**: it would build DPI 2 code into the DPI 1 service (the DPI 2 backend applies forward-only SQLite migrations on start). Run DPI 1 redeploys from `release/dpi1` until DPI 1 is decommissioned.
2. **Commit or stash the pending work on `main`** (plan docs, `.gitignore`) as its own commit so the tree is clean.
3. **Dress rehearsal on a throwaway branch.** `git switch -c integrate/dpi2 dpi2`, then `git merge main` (a no-op today, real once `main` moves). Resolve conflicts there, never on `main`.
4. **Run the gates on the integration branch** (section 4).
5. **Merge with history preserved:** on `main`, `git merge --no-ff integrate/dpi2 -m "Merge DPI 2 (Radar UrbiNexus)"`. `--no-ff` keeps one commit per item for review and makes the whole release revertible with a single `git revert -m 1 <merge>`. Do not squash: the item reports reference the commit hashes.
6. **Tag:** `git tag -a v2.0.0 -m "DPI 2"` on the merge commit (use `v2.0.0-rc1` on `dpi2` before the client's final approval). Push `main` and the tags only when the client has approved; pushing is a separate, explicit decision.
7. Keep the branch `dpi2` for one release cycle, then delete it.

## 4. Tests and checks to run before the merge

- `npm ci && npm run build` (shared, backend, frontend).
- `npm test` (default suite needs no Docker or AWS). Optional full contract run with DynamoDB Local: `DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm test`.
- `npx tsc -b --noEmit` in `packages/frontend`; `cd infra && npx tsc --noEmit && npm run check`.
- `npm run check:deploy`.
- Docker: build both images and run the ECS-style shared-namespace check from the runbook; `docker compose up` and `/api/health` through the proxy.
- A secret scan of the merged tree and history reachable from `dpi2` (no API key, access key, webhook URL, private key, `.env`, `*.sqlite`).
- Dry-run of `deploy-ecs-dpi2.sh` and `redeploy-dpi2.sh`.

## 5. Running both versions during the transition

- DPI 1: `dpi.urbani.io`, one task, SQLite on a task-local volume, deployed from `release/dpi1` with `deploy-ecs.sh` / `redeploy.sh`.
- DPI 2: `dpi2.urbani.io`, two tasks in two AZs, DynamoDB, deployed from the integrated tree with `deploy-ecs-dpi2.sh` / `redeploy-dpi2.sh`.
- They share only the cluster, VPC, ALB and certificate. They have separate service, task family, target group, rule, log group, roles, secrets, ECR repos and data.
- Cutover and rollback are two `modify-rule` calls on the ALB (runbook section 8). DPI 1 is scaled to zero only after the observation period, and deleted later (runbook section 9).

## 6. DPI 1 carry-overs to close (independent of the merge)

1. **Rotate the shared Urbani API key.** It was exposed in DPI 1 conversations. Urbani issues a new key; store it in `urbaniqa/dpi2/urbani-api-key` and update DPI 1's secret (`urbaniqa/observability/api-key`) and force a new DPI 1 deployment so it picks the new value.
2. **Replace the default admin password.** DPI 1 still uses `admin@urbani.io` with the default password. Change it now through the application (the account is Super Admin), or retire DPI 1 quickly. DPI 2 generates a random password in Secrets Manager and requires you to change it after first login.
3. **Keep-alive 502 fix.** The intermittent 502 from the ALB reusing connections that Node closed after 5 s is fixed in the DPI 2 backend (`keepAliveTimeout` 65 s, `headersTimeout` 66 s, commit `1684a54`). If DPI 1 stays live for long, apply that two-line change to `release/dpi1` by hand (the commit also contains other item 13 changes, so do not cherry-pick it whole) and redeploy DPI 1 from there.
4. **DPI 1 data is task-local.** Any task replacement erases it. Decide the migration option (runbook section 10) before DPI 1 is touched again.
