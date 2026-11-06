# Log search (DPI 2, item 4)

`GET /api/logs` (permission `logs:view`) supports severity, server, date range, text, regex, sort and pagination. Every search is audited as `logs.search` (filter parameters only, never log content).

## Parameters

| Param | Type | Notes |
|---|---|---|
| `levels` | `DEBUG,INFO,WARN,ERROR,FATAL` | Comma-separated or repeated. Legacy `level` is merged in. |
| `services` | names | Comma-separated or repeated. Legacy `service` is merged in. The UI calls this dimension "Server". |
| `from`, `to` | ISO 8601 date-time with offset | Inclusive. `from` after `to` is a 400. |
| `search` (alias `text`) | string, max 1000 | Case-insensitive substring. |
| `regex` | `true`/`false` | When `true`, `search` is a case-insensitive regular expression. |
| `sort` | `newest` (default), `oldest` | By timestamp. |
| `page`, `pageSize` | ints | `pageSize` 1..200, default 50. Pagination runs over the scanned window. |
| `environment` | string | Unchanged. |

Response: the usual `Sourced` envelope (`source`, `sourceNote`, `data`) plus `meta`:
`applied` (filters actually used), `sort`, `total` (matches inside the scanned window, not the whole stream), `truncated` (window cap hit, more matches may exist), `windowCap`, and `scope` (plain-language description of what was searched).

Errors: `400` for invalid levels/dates/ranges, invalid or unsafe regex; `401` without a token; `403` for roles without `logs:view` (none of the four draft roles lacks it today).

## Regex safety

User regexes never run with unbounded cost.

1. Static checks (`lib/safeRegex.ts`): max length (`LOGS_REGEX_MAX_LENGTH`, default 200), must compile, no back-references, and no ambiguous repetition. A group that is quantified (`*`, `+`, `{n,}`, `{n,m>1}`) and itself contains a quantifier or an alternation is rejected, e.g. `(a+)+`, `(a|aa)*`, `(.*a){10,}`. These are the shapes behind catastrophic backtracking. This is deliberately conservative: `(error|warn)` is fine, `(error|warn)+` is not.
2. Bounded input: each message is truncated to 1000 characters before matching.
3. Time budget: matching runs inside `node:vm` with a 250 ms timeout, so V8 stops a runaway match. A timeout returns 400, never a silent partial result.

Tests: `src/lib/safeRegex.test.ts` (known ReDoS patterns rejected; a pattern that bypasses validation is stopped by the timeout), route and adapter tests.

## Scope: what is actually searched

| Source | `source` | Scope |
|---|---|---|
| Mock (`INTEGRATION_MODE=mock`) | `MOCK` | Seeded demo lines. |
| Urbani API (`INTEGRATION_MODE=live`, default `LOGS_SOURCE`) | `LIVE` | `/logs/latest` + `/logs/history` windows merged with lines from recent incident evidence, capped at 100 lines. The upstream returns only "relevant" (flagged) lines, so this is NOT the full stream. |
| CloudWatch Logs Insights (`LOGS_SOURCE=insights`) | `LIVE` | The full stream of the configured log groups, default window last 24 h when no date range is given, capped at `LOGS_INSIGHTS_MAX_RESULTS`. |

Servers with no accessible source (not configured, access denied, query timed out) are named in `sourceNote`. If none of the requested servers can be read the response is `WAITING_FOR_INTEGRATION` with an empty list. Main and Payment never show `LIVE` unless they were really read.

Levels are inferred from message text (or an embedded JSON `level`) because Insights has no severity field. In Insights mode the level filter is applied after retrieval, inside the capped window.

## Switching to Logs Insights

```
LOGS_SOURCE=insights
LOGS_INSIGHTS_LOG_GROUPS=main=/aws/ecs/urbaniqa-qa-main/app,payments=/aws/ecs/urbaniqa-qa-payments/app
LOGS_INSIGHTS_TIMEOUT_MS=15000
LOGS_INSIGHTS_MAX_RESULTS=1000
```

The adapter (`integrations/aws/CloudWatchLogsInsightsAdapter.ts`) runs one `StartQuery` per server log group, polls `GetQueryResults` until `Complete` or the timeout, and parses `@timestamp` and `@message`. The query string is built from validated filters: substring text is regex-escaped, a user regex is length and structure checked with only the delimiter escaped, control characters are rejected, and the limit is a clamped integer. It has been tested only with a mocked SDK client, not against real AWS.

## IAM (authored in `infra/lib/security-construct.ts`, not deployed)

Added to `UrbaniDashboardTaskRole` only when `logsInsightsLogGroups` is set (CDK context or `URBANI_LOGS_INSIGHTS_LOG_GROUPS`, comma-separated):

- `logs:StartQuery`, `logs:DescribeLogGroups` on the configured log group ARNs.
- `logs:GetQueryResults` on `*` (the action authorises on the query id, which has no group-scoped ARN).

## What we need from the client

- Log group names or ARNs for QA, Main and Payment, and the AWS account/region.
- Read access for the dashboard task role (the IAM above), or an extension of the Urbani `/logs` API that returns all lines with date range and text filters.
- Confirmation of the maximum search window and retention they expect in the UI.
