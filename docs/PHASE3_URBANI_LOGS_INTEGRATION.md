# Phase 3 — Real Urbani Logs Integration

Wires the real Urbani telemetry API into the app **through the existing
`CloudWatchAdapter` boundary**. No dashboard, business-logic, or API-contract
changes — only a new adapter and configuration.

## What was integrated

| Endpoint | Result | Handling |
|---|---|---|
| `GET {base}/logs/latest?service=urbani-app` (header `x-api-key`) | **200** | **LIVE** via `HttpUrbaniLogsAdapter` |
| `GET {base}/metrics/latest` | 403 (not provisioned) | stays **MOCK** |
| `GET {base}/services` | 403 (not provisioned) | stays **MOCK** |

Observed response envelope:

```json
{ "service_id": "urbani-app", "logs": [], "window_start": "...", "window_end": "...", "log_count": "0" }
```

The current 5-minute window is often empty (`log_count: 0`); the live path is
verified end-to-end regardless.

## How it works

```
Browser → nginx (/api) → backend
                          └── telemetryService.logs()
                                └── getIntegrations().cloudwatch   ← interface
                                      = HttpUrbaniLogsAdapter (LIVE)  when INTEGRATION_MODE=live + key set
                                      = MockCloudWatchAdapter (MOCK)  otherwise
                                        → GET /logs/latest (x-api-key, server-side)
```

- `INTEGRATION_MODE=live` selects real integrations where configured; anything
  not yet available (metrics, services, Bedrock, DynamoDB) transparently stays mock.
- The adapter maps the upstream `logs[]` defensively into the `LogEntry` contract
  (probes `timestamp`/`@timestamp`/`time`, `level`/`severity`, `message`/`@message`/`msg`,
  supports plain-string lines), normalizes levels, and caches per the refresh window
  so the API is polled at most once per cycle. Stale cache is served if a refresh fails.

## Configuration (single model, no secrets in source)

```
INTEGRATION_MODE=live
URBANI_API_BASE_URL=https://<id>.execute-api.<region>.amazonaws.com/prod
URBANI_API_KEY=<secret — env / secret manager only>
URBANI_SERVICE=urbani-app
URBANI_REFRESH_MINUTES=5
```

In Docker these are passed to the backend via `docker-compose.yml` from the
root `.env`. The key is **never** hardcoded, logged, returned in API responses,
or shipped to the browser (the call is server-side only).

## Security

- API key read from env only; verified absent from API responses and server logs.
- Non-200 upstream responses raise `IntegrationError` without echoing the key.
- 15s request timeout; graceful fallback to cached window on transient failure.
- **Action required:** the key shared during setup was transmitted in plaintext —
  **rotate it** and set the new value via environment/secret manager.

## Validation

- 5 new unit tests for the adapter (mapping, level normalization, filtering,
  error handling without key leak, mock-metrics fallback). Full suite: **21/21 pass**.
- Backend build clean; Docker rebuild clean.
- Live smoke test (bare-metal and via the reverse proxy): `integrationMode=live`,
  `/api/logs` returns `source: LIVE`, key not present in bundle/logs/responses.

## Not changed (per integration guardrails)

- Adapter interfaces, `AIProvider`, mock providers — all preserved.
- Dashboard components and the `/api/*` contract — unchanged.
- Bedrock model config remains env-driven; no AWS SDK in React; `INTEGRATION_MODE` retained.
