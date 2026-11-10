# DPI 2 item 1 — baseline

- Main commit: `5cc5ffa05d41f47c61dc6d5c423bda51cc11b188` (main workspace untouched)
- Main workspace `git status --short` at setup:
  ```
  ?? .agents/tasks/dpi2-diagram-plan.md
  ?? .agents/tasks/dpi2/
  ?? .agents/tasks/task-dpi2-diagram/context.json
  ?? .agents/tasks/task-dpi2-diagram/verdict.json
  ?? DPI2_Urbani_UrbiNexus_EN.docx
  ?? OUTPUT/Urbani_DPI2_Plan.pdf
  ?? Upgrades_UrbiNexus_DPI_EN.pdf
  ?? docs/DPI2_PLAN_AND_GAP_ANALYSIS.md
  ?? scripts/gen-dpi2-docs.js
  ```
- Worktree: `C:/Antigravity/Urbani DPI/.worktrees/dpi2`, new branch `dpi2` from main
- dpi2 HEAD: `5c819087a0f19b846bc27ecff85ef5f9a6fcbcac`
- .gitignore changed: yes. `.worktrees/` was not ignored, so the worktree's `.gitignore` got a `.worktrees/` line, committed on dpi2 as `chore: ignore .worktrees/`.
- Install: `npm ci` succeeded. The first attempt was interrupted and a retry hit a transient EBUSY lock on node_modules/better-sqlite3. The fix was to delete the worktree's node_modules and run `npm ci` again, which exited 0. package-lock.json was not changed.
- Baseline tests (`npm test`, which runs backend vitest):
  - Fresh worktree: 5 test files failed and 6 passed (11 total). All 40 collected tests passed. The 5 failed files could not load `@urbani/shared` because `packages/shared/dist` (git-ignored) had not been built yet.
  - After `npm run build --workspace @urbani/shared`: **11/11 test files passed, 73/73 tests passed, 0 failed, 0 skipped.**
  - Later steps in a fresh checkout must build `@urbani/shared` before running the tests.
- Docker: the CLI is installed (client 29.8.0) but the daemon is **not running**. The CLI cannot reach the Docker Desktop Linux engine pipe. No container was started.
