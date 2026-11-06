# Export (DPI 2 item 11)

One permission, `logs:export`, covers every export below (logs, alerts, incident report). Draft matrix: Super Admin, Infra Admin, QA Operator and Reader/Auditor all hold it (see RBAC.md; pending client sign-off, including whether auditors may export).

## Endpoints
| Endpoint | Formats | Filters |
|---|---|---|
| `GET /api/logs/export` | `format=csv\|json\|pdf` (required), `bom=true\|false` (CSV, default true) | Exactly the `GET /api/logs` filters (levels, services, from, to, search, regex, sort, environment). `page`/`pageSize` are ignored. Same safe-regex rules. |
| `GET /api/alerts/export` | `csv`, `json` | severity, service, environment, anomalyType, status, search, from, to |
| `GET /api/alerts/:id/report` | `pdf` | none (404 for an unknown id) |

Errors: 401 unauthenticated, 403 without `logs:export`, 400 bad parameters, 429 rate limited (`Retry-After`), 404 unknown incident.

## Semantics
Exports contain only what the user may see and what the data source returned. Nothing is fabricated. Every export states its coverage:
- **source**: LIVE / MOCK / WAITING_FOR_INTEGRATION (response header `X-Export-Source`, JSON `meta.source`, PDF cover badge).
- **scope**: the log search scope note (for example "latest + history window and incident evidence" vs "full stream via Logs Insights").
- applied filters, row count, truncation flag, generated-at (UTC), generated-by.
- `X-Export-Rows`, `X-Export-Truncated`, `Content-Disposition: attachment; filename="urbani-<kind>-<UTC yyyymmdd-HHmmss>.<ext>"`, `Cache-Control: no-store`.

Truncated means: the source returned a capped window, or the row cap below was hit. The default log source is a capped window (100 lines), so "truncated" is often true until Logs Insights is configured.

## Formats
- **CSV**: RFC 4180, CRLF, UTF-8 with BOM (so Excel shows Spanish accents), streamed row by row with back-pressure. Cells starting with `= + - @ TAB CR` get a leading `'` (formula injection protection). Log columns: `timestamp,level,service,environment,message,id`. Alert columns: `alertId,timestamp,service,environment,severity,anomalyType,status,summary,probableCause,confidence,confidenceDerived,recommendedActions,evidenceCount`. `confidenceDerived` is true for LIVE alerts, whose confidence is derived from severity (the source gives no model score).
- **JSON**: `{"meta":{source,sourceNote,scope,filters,rowCount,truncated,generatedAt,generatedBy,exportMaxRows},"items":[...]}`, streamed.
- **PDF** (pdfkit 0.15.1, standard Helvetica only): cover block (brand, provenance badge, filters, scope, truncation notice), table of timestamp/level/service/message with a repeating header and "Page X of Y" footers. Text is reduced to WinAnsi (accents kept, other glyphs become `?`), messages over 600 characters are cut with `... [truncated]`, long unbroken tokens get break points. The incident report PDF has severity/status badges, summary, probable cause, derived-confidence label, recommended actions, correlated evidence lines, related logs, acknowledgement info and generated-by/at.

## Limits and safety
| Variable | Default | Meaning |
|---|---|---|
| `EXPORT_MAX_ROWS` | 10000 | Max rows for CSV/JSON (log adapters may return fewer) |
| `EXPORT_PDF_MAX_ROWS` | 2000 | Max rows in a PDF, with a visible notice |
| `EXPORT_RATE_LIMIT_PER_MIN` | 10 | Per user, shared by all export endpoints (in-memory, single instance) |
| `EXPORT_TIMEOUT_MS` | 60000 | Hard deadline; the connection is closed |

The stream stops when the client disconnects. A failure after streaming started closes the connection, so a cut file is not mistaken for a complete one.

## Audit
`logs.export`, `alerts.export`, `incident.report` (SENSITIVE_QUERY): format, redacted filters, rowCount, truncated. Never the rows or content.

## Follow-up (not built)
Very large exports could be staged in S3 and returned as a pre-signed link. Needs a bucket and a retention decision from Urbani. Exported files are not stored by the platform.
