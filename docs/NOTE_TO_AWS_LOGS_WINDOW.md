# Note to AWS Team — Logs endpoint returns an empty window

**From:** Urbani dashboard/chatbot development
**Date:** 6 Oct 2026
**Subject:** `/logs/latest` is reachable and returns HTTP 200, but the log window is empty. Alerts, chat, and auth all work. We need either real log activity or a historical/parameterised logs endpoint.

---

## TL;DR

The dashboard integration against your APIs is **working**. Alerts, alert history, and the AI chat all return real data. The **only** gap is that `GET /logs/latest` returns a valid but **empty** 5‑minute window, so the dashboard's Logs page and the chatbot's live‑log grounding have nothing to display. This is **not** a problem on our side — the same API key succeeds on every endpoint. We believe the fix is on the AWS side. Two options are below; option B (a historical/parameterised endpoint) is our preference.

---

## What is working (verified end to end with the current key)

Base URL: `https://830oi1gxng.execute-api.ap-south-1.amazonaws.com/prod`
Region: `ap-south-1` · Service: `urbani-app` · Auth: `x-api-key` (current rotated key)

| Endpoint | Result |
|---|---|
| `GET /alerts/latest?service=urbani-app` | **HTTP 200**, returns a real alert |
| `GET /alerts/history?service=urbani-app&limit=5` | **HTTP 200**, returns real alert history |
| `POST /chat` | **HTTP 200**, real Bedrock Nova Lite answer |
| `GET /logs/latest?service=urbani-app` | **HTTP 200**, but `log_count: 0` (empty window) |

So authentication, networking, and three of the four endpoints are confirmed healthy.

## The issue, with evidence

A side‑by‑side probe of `/alerts/latest` and `/logs/latest`, same API key, same moment:

```
probe time (UTC):  2026-10-06T08:14:00Z

ALERTS/latest : HTTP 200 | alertId = ALT-B75EBB4673B0 | timestamp = 2026-10-06T07:02:54Z
LOGS/latest   : HTTP 200 | log_count = 0 | window 2026-10-06T08:07:51Z -> 2026-10-06T08:12:51Z
```

Interpretation:

- **Alerts persist**, so they always have content — the alert above was generated at **07:02** and is still returned over an hour later because `UrbaniAlertWriterFn` stored it in `UrbaniAlerts` (DynamoDB).
- **`/logs/latest` is a rolling 5‑minute view only** — it returned the window `08:07 → 08:12`, and `urbani-app` emitted nothing in those 5 minutes, so `log_count = 0`.
- The log activity that *generated* the 07:02 alert is long outside the current 5‑minute window, so `/logs/latest` cannot show it.

The response is well‑formed and the call authenticates correctly — the window is simply empty because the application was idle in that interval.

## What we already checked on our side (so you can rule it out)

- The API key is the current rotated one and works on all four endpoints (no 403 on logs).
- `/logs/latest` **ignores time‑range query parameters.** We tried `?minutes=60`, `?window=60`, `?hours=24`, and `?limit=100` — every variant returned the **identical fixed 5‑minute window** with `log_count: 0`. So there is no client‑side way for us to request a wider range or history.
- Our backend reads the key server‑side only (never exposed to the browser) and labels the Logs page `LIVE` — it faithfully shows whatever `/logs/latest` returns.

## What we need from you (either option works; B preferred)

**Option A — Generate real activity for a live demo (quick).**
Trigger some log output on `urbani-app` (normal traffic, or a deliberate test `ERROR`), then tell us the ~5‑minute window to look in. We'll refresh the Logs page within that window and confirm the live‑logs path end to end. This proves the pipeline but only shows data transiently.

**Option B — Add a historical or parameterised logs endpoint (preferred, durable).**
Extend the logs API so it can return more than the last 5 minutes, e.g.:

- a `GET /logs/history?service=urbani-app&limit=N` endpoint (mirroring `/alerts/history`), and/or
- accept a time‑range on `/logs/latest` such as `?minutes=` / `?from=` / `?to=` (currently these params are ignored).

This lets the dashboard show recent log history and lets the chatbot ground answers in a meaningful window even when the app is momentarily idle. Mirroring the `/alerts/history` shape would be ideal for consistency.

## Questions

1. Is the 5‑minute window on `/logs/latest` intended to be fixed, or can it be parameterised/widened?
2. Which CloudWatch log group and region does `UrbaniTelemetryCollectorFn` read from? (We expect `/aws/elasticbeanstalk/urbani-app` in `ap-south-1` — please confirm.)
3. Is `urbani-app` currently receiving traffic, or is it idle most of the time? (Determines whether option A alone is enough.)
4. Can you share one **sample `/logs/latest` response that contains log entries** so we can confirm our field mapping (timestamp, level, message, service) against real data? We have only ever observed the empty shape.

## Reference — the empty response we consistently see

```json
{
  "service_id": "urbani-app",
  "logs": [],
  "log_count": "0",
  "window_start": "2026-10-06T08:07:51Z",
  "window_end": "2026-10-06T08:12:51Z"
}
```

Thanks — everything else is wired and working on our end; this is the last piece to light up the Logs page and give the chatbot a non‑empty window to reason over.
