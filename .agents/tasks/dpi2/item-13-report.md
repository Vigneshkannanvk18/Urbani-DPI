# Item 13: Load and performance tests (DPI 2) - report

Status: DONE (integration pending). Branch `dpi2` in `.worktrees\dpi2`. Not pushed. No AWS calls; only a local mock backend was loaded.

## What was built
- `MOCK_LOG_VOLUME` (default 0): deterministic (seeded) synthetic logs in `MockCloudWatchAdapter`. Honoured only with `INTEGRATION_MODE=mock` and `NODE_ENV != production`, otherwise ignored with a startup warning. Generated once on first use (200k lines: about 0.35 s, about 100 MB heap), columnar index, labelled MOCK with a "SYNTHETIC ... not real telemetry" scope. Spanish, JSON-looking and long stack-trace lines included. Filters, sort, paging, regex (safe-regex budget kept) and exports work over it; export still capped by `EXPORT_MAX_ROWS`.
- `load/scenarios.json` (9 scenarios, 5 profiles: smoke, realistic, search-heavy, spike, soak), `load/thresholds.json` (DRAFT).
- `load/node/run.mjs` (zero deps), `load/node/serve.mjs` (local mock backend), `load/k6/dpi-load.js` + generated `dpi-load.standalone.js` (single file for AWS DLT), `load/lib/shared.mjs`.
- `scripts/ui-perf.mjs` (CDP, long tasks, DOM, heap, layouts; optional background load). Output in `.tmp/ui-perf/`.
- `docs/LOAD_TESTING.md`, `.env.example`, `.gitignore` (`load/results/`).
- Tests (+19, default suite 638 passed / 104 skipped, was 619): generator determinism, production guard, filter/sort/cap parity vs reference implementation on a 20k set, regex yield, thresholds evaluator, scenario schema and route existence, k6 bundle sync.

## Machine
Intel Core i5-1235U (10 cores / 12 threads), 39.7 GB RAM, Windows, Node v24.13.0, headless Edge. Mock integrations, SQLite. **Not** a Fargate 0.5 vCPU task behind an ALB. The machine was shared with other apps (Teams, IDE), so runs vary: login p50 ranged 82 to 149 ms between runs.

## Results (latency ms p50/p95/p99, all error rate 0% unless noted)
| Run | Load | req/s | Read | Search | Regex | Export | Chat | Verdict (x1) |
|---|---|---:|---|---|---|---|---|---|
| A smoke, default data | 25 VUs, 45 s | 7.7 | 3/32/90 | 5/36/77 | 18/34/34 | 25/31/31 | 4/7/7 | PASS |
| B realistic, 50k lines | 50 VUs, 150 s, 7 users | 15 | 4/10/19 | 6/18/33 | 15/61/120 | 30/99/129 | 6/24/78 | PASS |
| B2 realistic, no think time (capacity) | 50 VUs, 60 s | 426 | 86/141/177 | 87/143/179 | 167/1435/1687 | 101/163/762 | 86/140/161 | PASS |
| C 200k, search-heavy | 25 VUs, 90 s | 25 | 3/15/29 | 6/17/27 | 17/163/225 | 25/46/87 | - | PASS |
| C7 200k, search-heavy (final code, noisy machine) | 25 VUs, 90 s | 22 | 12/169/1528 | 23/496/1991 | 68/1370/3401 | 107/1280/2306 | - | PASS (regex 1370 near 1500) |
| C2 200k capacity, no think time (before fix) | 50 VUs, 120 s | 161 | 145/303/439 | 148/305/423 | 410/1865/2021 | 163/379/1351 | - | BREACH regex p95 |
| C4 200k capacity (after fix, busy machine) | 50 VUs, 90 s | 81 | 497/854/996 | 496/845/993 | 568/2257/2785 | 544/964/3827 | - | BREACH read, regex |

Login (bcrypt) measured alone, sequential x20: p50 82 to 149 ms, p95 85 to 168 ms (limit 1500). Server (run B): about 10% of one core average, RSS 108 to 180 MB. At saturation (B2): about 103% of one core (event loop is single threaded: Node is CPU-bound on one core at about 430 req/s of these cheap mock endpoints), RSS up to 482 MB. 200k dataset: RSS 170 to 583 MB under search load, ran fine with `--max-old-space-size=400`.

Caveat on C2 to C4: run C2 was on a quiet machine, C3/C4/C7 on a visibly busy one (system CPU 20 to 55% from other apps), so they are not a clean before/after comparison of the regex change. I did not prove the regex yield change improves p95; it is a reasoning-based tweak (yield only after about 40 ms of work instead of after every 4000-line batch) and is kept because it cannot make correctness worse (tests cover it).

## UI perf (50k lines, headless Edge, with and without background API load of 15 VUs)
| Metric | No background | With background | Draft limit |
|---|---:|---:|---:|
| Logs first rows (warm) | 474 ms | 382 ms | 2500 |
| Logs first rows (cold, Vite dev server transforming modules) | 2564 ms | 503 ms | 2500 (dev-server artefact) |
| Longest long task during interaction (paging, filter, typing, regex) | 0 (none over 50 ms) | 0 | 250 |
| Long tasks on initial page loads | 1 (102 ms) | 1 (80 ms) | n/a |
| Dashboard ready / Alerts ready | about 507 / 568 ms | about 392 / 359 ms | n/a |
| DOM nodes on Logs (50 rows/page) | 478 | 478 | 5000 |
| JS heap max / growth after 15 filter cycles with GC | 12 MB / +0.8 MB | 12 MB / +0.9 MB | 250 |
All four draft UI thresholds pass. No UI change was needed: page size is fixed at 50, text input is debounced 400 ms, rows are few. Typing and regex produce one refetch per debounce, not per keystroke. Screenshots in `.tmp/ui-perf/` (not committed).

## Bottlenecks
Fixed:
1. `server.keepAliveTimeout` was Node's default 5 s; behind an ALB (60 s idle) that causes intermittent 502s. A load run showed one `ECONNRESET` with keep-alive clients. Now 65 s / headersTimeout 66 s. No unit test (server bootstrap is not unit-testable here); the later run C7 had 0 errors.
2. Search over large arrays: designed the synthetic search as a time-sorted index with binary-search date ranges, early exit at the limit, cached lower-cased text, batched regex with total time budget and event-loop yielding. 200k text search about 15 to 20 ms unloaded; regex no-match scan about 100 to 170 ms.
Not fixed, recommendations:
- Node is single threaded: capacity about 430 req/s per core on cheap endpoints. Run at least 2 tasks (already planned) and autoscale on CPU.
- Regex at saturation is the slowest path (p95 1.4 to 2.8 s with no think time on 200k). Move search to CloudWatch Logs Insights for large volumes, or lower the synthetic/search window.
- Cache `/api/dashboard/summary` and `/api/health/status` 5 to 10 s if many users poll.
- Export CSV of 10k rows is about 1 MB per request, 12 to 15 MB/s at saturation; keep the per-user limit (10/min) and consider S3 for large exports.
- `logs.search` writes an audit row per request (synchronous SQLite insert): fine here, watch it on DynamoDB.
- Rate limits are per IP (login 10/min, chat 30/min), per user (export). Behind an ALB with `trust proxy 1` that is per client IP; load from a single DLT task IP will hit 429s unless limits are relaxed for the test env.
- Rate-limit store is in memory per task (limits multiply with the number of tasks).

## Not exercised (honest)
k6 itself (not installed; script only syntax-checked with `node --check` and bundle-sync tested), AWS DLT, real ALB/Fargate/0.5 vCPU, real Urbani APIs or Bedrock latency (chat ran on the mock provider), real DynamoDB. The optional DynamoDB Local comparison run was skipped to save time. Spike and soak profiles were defined but not run. UI measured against the Vite dev server (unminified), not the production nginx bundle.

## Client input needed
1. Agreed SLO thresholds (p95 per endpoint group, error budget); current values are placeholders (client input #14).
2. Expected concurrent users and peak log rate (lines/s), so profiles and `MOCK_LOG_VOLUME` match reality.
3. Permission to run DLT, and against which environment (dedicated, mock or rate-limited upstream; never production or the Urbani QA gateway without approval).
4. Acceptable p95 for live chat (a real Nova answer is much slower than the mock).

## Files
`load/**`, `scripts/ui-perf.mjs`, `docs/LOAD_TESTING.md`, `packages/backend/src/integrations/mock/{syntheticLogs.ts,syntheticLogs.test.ts,MockCloudWatchAdapter.ts}`, `lib/mockLogVolume.ts`, `load/loadAssets.test.ts`, `config/index.ts`, `integrations/index.ts`, `services/telemetryService.ts`, `server.ts`, `.env.example`, `.gitignore`.
