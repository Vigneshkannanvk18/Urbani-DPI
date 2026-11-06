# Service health / uptime panel (DPI 2 item 9)

Page: **Service Health** (`/health`) and a status strip on the Dashboard. API: `GET /api/health/status`, `GET /api/health/history?target=&range=24h|7d|30d`, `POST /api/health/check-now`. The existing `/api/health` and `/api/ready` probes are unchanged.

## What is measured (honesty)
| Target | Measures | Needs |
|---|---|---|
| **Radar API** (`radar-api`) | this service: database ping via the repository readiness check | nothing |
| **Urbani QA telemetry API** (`urbani-qa-telemetry-api`) | reachability of the Urbani **observability API** (`GET /logs/latest` with the existing API key). It is **not** the health of the customer's QA application | `URBANI_API_BASE_URL` + `URBANI_API_KEY` |
| **QA**, **Main**, **Payment** (`qa`, `main`, `payment`) | the customer applications' own health endpoints | an entry in `HEALTH_TARGETS` |

QA / Main / Payment without a URL show **WAITING_FOR_INTEGRATION** with the note "No health endpoint configured -- needs Urbani input" and the setting to add. They are never shown as UP or LIVE and are never probed or stored.

Statuses: `UP`, `DEGRADED` (slower than `degradedAboveMs`, or reachable but an unexpected HTTP status), `DOWN` (timeout, refused, DNS/TLS error, blocked), `UNKNOWN` (configured but no fresh result), `WAITING_FOR_INTEGRATION`. The **LIVE** badge appears only when a target was actually probed and the latest result is fresh (younger than 3 intervals, min 3 min).

Uptime % = UP samples / all samples in the window (strict: DEGRADED counts against it). With fewer than `HEALTH_MIN_SAMPLES` samples the UI shows "insufficient data" and the sample count, never a fake 100%.

## HEALTH_TARGETS
JSON array in one env var:
```json
[{"id":"main","type":"http","url":"https://main.example.com/health","method":"GET","expectedStatus":[200],"timeoutMs":5000,"degradedAboveMs":2000,"service":"main"}]
```
`id` (lowercase, `a-z0-9_-`), `type` is always `http`, `url` http(s) without credentials. Optional: `name`, `method` (GET|HEAD), `expectedStatus` (default any 200-399), `timeoutMs` (5000), `degradedAboveMs` (2000), `service` (Urbani service id, to show open alert counts; defaults to `id` when that is a configured service). Invalid entries are skipped and listed on the page; they never stop the server and their URLs are never echoed.

## Probing
Background scheduler (`HEALTH_PROBES_ENABLED`, default on, off in tests): interval `HEALTH_PROBE_INTERVAL_SECONDS` (60) with +/-10% jitter, single-flight, unref'd timer, aborted on SIGTERM. Results go through the repository layer (SQLite migration 006, DynamoDB `HEALTHRES#<target>` items), one per target per minute, last write wins. **With 2+ ECS tasks every task probes**; this is accepted and harmless because writes are idempotent per minute. Retention: `HEALTH_RETENTION_DAYS` (30), daily purge job. "Check now" needs `settings:update`, is rate limited and audited.

## SSRF rules
URLs only from env. http(s) only, no embedded credentials. Always blocked: 169.254.0.0/16 (incl. 169.254.169.254), fe80::/10, `fd00:ec2::/32`, 0.0.0.0/8, multicast/reserved, 100.100.100.200. Loopback, RFC 1918, 100.64/10 and fc00::/7 are blocked unless `HEALTH_ALLOW_PRIVATE_TARGETS=true` (needed for internal ALB targets). The check runs on the resolved IP at connect time (DNS-rebinding safe) and on every redirect hop (max 3). Response reads are capped (`HEALTH_MAX_RESPONSE_BYTES`). Errors are short fixed reasons; URLs with query strings or credentials are never logged or stored.

## IaC (authored, not deployed)
`cd infra && cdk synth -c enableHealthMonitoring=true -c healthEndpoints=https://a.example.com/health,https://b.example.com/status` adds Route 53 HTTPS health checks, a CloudWatch Synthetics heartbeat canary (inline Node.js, encrypted artifact bucket with 30-day lifecycle, minimal IAM role) and alarms (SNS action when `enableNotifications` is also on). Off by default; the existing stack is unchanged. Route 53 health-check metrics exist only in us-east-1, so those alarms are created only there. Container Insights is an item-14 (deploy script) concern.

## Needed from Urbani
1. Health URLs for QA, Main and Payment (and the expected status / auth, if any).
2. Whether they are reachable from the ECS task network (public internet, or internal ALB -> then `HEALTH_ALLOW_PRIVATE_TARGETS=true` and security-group rules).
3. Which endpoints Route 53 / Synthetics should watch from outside.