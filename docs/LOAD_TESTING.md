# Load and performance testing (DPI 2 item 13)

Everything here is **dev/test tooling**. Thresholds are **DRAFT placeholders pending Urbani (client input #14)**.

## What is in the repo

| Path | Purpose |
|---|---|
| `load/scenarios.json` | Shared scenario definition: endpoints, checks, think times, profiles and weights. Read by both runners. |
| `load/thresholds.json` | DRAFT SLOs per request group (p95 read 800 ms, search/regex 1500, export 3000, login 1500, chat 3000; error rate < 1%). |
| `load/node/serve.mjs` | Starts the compiled backend locally: `INTEGRATION_MODE=mock`, fresh SQLite under `.tmp/load`, `MOCK_LOG_VOLUME`, rate limits off. |
| `load/node/run.mjs` | Dependency-free runner (Node 24, `node:http` keep-alive). Same scenarios as k6. Table + `summary.json` + `summary.md` in `load/results/<timestamp>/` (gitignored). Exit 1 on breach. |
| `load/k6/dpi-load.js` | k6 script (stages, thresholds, tags per request group, `setup()` logs in once). |
| `load/k6/dpi-load.standalone.js` | Same script with both JSON files inlined, for AWS Distributed Load Testing. Regenerate with `node load/k6/bundle.mjs` (a test fails if it is stale). |
| `scripts/ui-perf.mjs` | Headless Edge (CDP) UI performance check of Logs, Dashboard, Alerts. |

## Synthetic log volume

`MOCK_LOG_VOLUME=N` (default 0 = current seeded 60 lines). Honoured **only** with `INTEGRATION_MODE=mock` and `NODE_ENV != production`; otherwise it is ignored and the backend logs a startup warning. Lines are deterministic (seeded RNG), generated once on first use (about 0.35 s and about 100 MB for 200,000 lines), labelled `MOCK`, with a scope note that says they are synthetic. They include Spanish messages, JSON-looking messages and long stack traces. While it is on, a search returns up to 5,000 matches (stand-in for the Insights window) and exports up to `EXPORT_MAX_ROWS`; the regex time budget (250 ms per batch, 1.5 s total, partial result flagged in the scope text) and the export caps still apply.

## Run locally (no k6 needed)

```
npm run build
node load/node/serve.mjs --volume 50000 --port 4100          # terminal 1
node load/node/run.mjs --profile realistic --vus 50 --duration 150s --rampUp 30s --users 6   # terminal 2
node load/node/run.mjs --profile search-heavy --vus 25 --thinkScale 0.25                     # log-heavy
node scripts/ui-perf.mjs                                      # UI; UI_PERF_BG=1 adds background API load
```

Useful flags: `--thinkScale 0` (capacity test, no think time), `--thresholdScale 3` (stretch latency limits for a laptop), `--scenarios logs-search,logs-regex`, `--serverPid <pid>` (CPU/RSS sampling), `--noFail`. Profiles: `smoke`, `realistic` (60% dashboard/browse/alerts/audit, 25% search, 5% regex, 5% export, 5% chat), `search-heavy`, `spike`, `soak` (raise `--duration`).

Rate limits are disabled for these runs (`RATE_LIMIT_DISABLED=1`): login is limited to 10/min per IP, chat to 30/min per IP and export to 10/min per user, which a single-IP load generator would hit by design. Test the limiters separately (they return 429).

## k6

Locally, once k6 is installed:

```
k6 run -e BASE_URL=http://127.0.0.1:4100 -e USERNAME=admin@urbani.local -e PASSWORD=... -e PROFILE=smoke load/k6/dpi-load.js
```

Env: `BASE_URL`, `USERNAME`, `PASSWORD`, `PROFILE`, `VUS`, `DURATION`, `RAMP`, `THINK_SCALE`, `THRESHOLD_SCALE`, `SCENARIOS`. k6 was **not** executed in this repository's session (not installed); the script is a direct port of the Node runner and has only been syntax-checked.

### AWS Distributed Load Testing (DLT)

1. `node load/k6/bundle.mjs`, then upload `load/k6/dpi-load.standalone.js` as the test script (type k6).
2. Set the script environment: `BASE_URL`, `USERNAME`, `PASSWORD`, `PROFILE`, `VUS` (per task), `THRESHOLD_SCALE`.
3. Pick the region(s), task count and ramp/hold times. Total users = tasks x `VUS`. Start with 1 task, 5 VUs, 2 minutes.
4. Compare the DLT report with the thresholds in `load/thresholds.json` (the k6 thresholds are the same numbers).

## Safety rules

- Never load production, `https://dpi.urbani.io` or the Urbani QA API Gateway without Urbani's written approval.
- Use a dedicated environment with `INTEGRATION_MODE=mock`, or rate-limit the Urbani API, so load does not reach Urbani QA, Bedrock (cost) or real notification channels.
- Start tiny, increase in steps, stop on rising errors. Use a dedicated test user, not a real admin.
- Load tests write audit events (`logs.search`, `logs.export`, `chat.query`) and chat history: use a disposable database.

## Machine caveat

Numbers from a developer laptop with mock integrations and SQLite are **not** a forecast for a Fargate 0.5 vCPU task behind an ALB. Use `--thresholdScale` to compare, and re-run on the real environment.
