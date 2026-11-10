# Implementation Plan — DPI 2 ("Radar UrbiNexus") Architecture Diagram + Docs

Goal: produce a NEW DPI 2 target architecture diagram (`OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.svg`/`.png`)
and extend the AWS deployment guide with a clearly-marked, honestly-labelled DPI 2 section. This is a
**documentation/diagram task only** — no changes to application source under `packages/`, no dev-server
restarts, no `.env` secret-value edits, and the DPI 1 diagram outputs + `gen-diagram.test.js` must stay
byte-for-behaviour unchanged.

---

## 0. Exploration findings (facts the implementer can rely on)

Read from the actual repo:

- **No `AGENTS.md`, `CONTRIBUTING.md`, or `.kiro/steering/`.** `README.md` documents the product and the
  npm-workspaces layout. The only conventions to follow are those visible in `scripts/*.js`.
- **`scripts/gen-diagram.js` is a self-contained CommonJS generator** (2-space indent, single quotes,
  semicolons, `/* ... */` header stating the OUTPUT file, `const OUT = path.join(__dirname, '..', 'OUTPUT')`,
  UPPER_CASE constants, `// --- Section ---` separators). It exports its engine via `module.exports`
  (`buildLayout`, `assertNoCollisions`, `emitSvg`, the primitives, and the content arrays) and runs
  `main()` only under `require.main === module`.
- **The engine is driven by a pure DATA content model** near the top: `TITLE_TEXT`, `SUBTITLE_TEXT`,
  `FRAME_TITLE_TEXT`, `GROUPS`, `NODES`, `PANEL_APP`, `PANEL_USERS`, `GOV_TILES`, `FOOTNOTES`, `LEGEND`,
  `EDGES`. Geometry is derived from a grid; nothing uses literal coordinates.
- **Grid model:** `GROUPS[].row` is a row index (DPI 1 uses 0 and 1); `GROUPS[].cols` is an inclusive
  column span `[first, last]`. `NODES[].group` + `NODES[].col` place a card. Columns are uniform width;
  each row has one card row. `EDGES[].shape` ∈ `h-row` (same row, horizontal), `v-col` (same column,
  vertical down into the next row), `trunk` (down → across → up to a bottom panel). Edge labels sit in
  reserved channel whitespace via `labelAt` ∈ `entry-above | gutter-above | rowgutter-left | trunk-below`.
- **The engine currently HARDCODES exactly 2 rows and 5 columns** in four spots:
  `rowPanelY`/`cardsY` are 2-element arrays with row 1 derived from row 0; the column-channel loops run
  `for i=1..5`; the inter-column gutter loop runs `for i=1..<5`; and `frameW`/`canvasW` use `colX(5)`.
  There is a single `ROW_GUTTER_Y` between row 0 and row 1 and a single `trunkY` band below the body.
- **Collision discipline (hard gate):** `assertNoCollisions` runs 13 rules over every rect/segment/arrow
  and `main()` calls `process.exit(1)` on any fail before writing. `--dry-run` builds + asserts without
  writing; `--debug` writes an overlay SVG. Reserved **channels** (rule 13) require every segment to lie
  inside the entry gutter, an inter-column gutter, a column corridor, the row gutter, or the trunk band —
  so any new row/column must add its channels or routing will fail rule 13.
- **`gen-diagram.test.js`** (`node --test scripts/gen-diagram.test.js`) imports `./gen-diagram`, asserts
  the real layout passes every rule, asserts `res.counts.cards === gd.NODES.length`, and asserts the
  "nudge a card" negative case still bites. **Baseline verified green: 11/11 pass; generator dry-run
  reports `0 collisions`, exit 0, 10 nodes.**
- **`sharp` ^0.35.5** is a root devDependency and rasterises the SVG to PNG at `density = 72*RASTER_W/canvasW`
  (`RASTER_W = 5400`). PNG emission works on this machine.
- **`OUTPUT/` holds the DPI 1 artifacts** that MUST NOT be touched: `Urbani_AWS_Architecture_Diagram.svg`/`.png`
  (consumed by the DPI 1 proposal/deck/cover), `Urbani_DPI_Documentation.pdf`, `Urbani_DPI2_Plan.pdf`.
- **`package.json`** has `"gen:diagram": "node scripts/gen-diagram.js"` and `"gen:docs"`, `"gen:dpi2"`.
- **`docs/AWS_DEPLOYMENT_GUIDE.md`** is the DPI 1 guide (ECS Fargate, SQLite/EFS vs DynamoDB decision,
  secrets table, IAM least-privilege). **`docs/DPI2_PLAN_AND_GAP_ANALYSIS.md`** is the authoritative DPI 2
  source of truth and already states the honesty framing (DPI 2 services are PROPOSED/TARGET; DPI 1 runtime
  is SQLite + un-deployed CDK scaffolding; Main/Payment ingestion depends on client access).
- `.gitignore` does not ignore `.agents/`; existing scratch plans already live in `.agents/tasks/`.

---

## 1. Decision: COPY the engine into a new generator (not a full refactor of gen-diagram.js)

**Decision: create `scripts/gen-diagram-dpi2.js` as a self-contained copy of the engine with a DPI 2
content model and a generalized (N-row / N-column) layout.** Do NOT refactor `gen-diagram.js` into a
shared module.

Rationale:
- The hard requirement is that the DPI 1 output AND `gen-diagram.test.js` stay unchanged in behaviour.
  `gen-diagram.test.js` imports `./gen-diagram` and asserts on its exported `NODES`, geometry, and the
  "nudge" negative case. A shared-engine refactor would force the DPI 1 content model through a newly
  parameterized engine, risking a change in the asserted geometry/counts for zero task benefit.
- A copy is lower-risk within the iteration budget and fully satisfies the "EITHER WAY" clause in the
  task. The DPI 2 generator needs an N-row grid (DPI 2 adds a third zone band); generalizing the row/column
  counts is cleaner to do in a fresh copy than to retrofit into the file the DPI 1 test pins.
- Cost of the copy: ~700 lines duplicated. Acceptable and explicitly sanctioned by the task as the
  fallback when a full refactor is "too invasive".

---

## 2. DPI 2 content model (the exact additions)

The DPI 2 diagram KEEPS the DPI 1 baseline (rows 0–1, all 10 nodes, 4 zones, both side panels, the
governance strip) rendered in the SAME gray/neutral palette, and ADDS a **third zone band (row 2)** of
DPI 2 proposal nodes drawn with an **orange accent** (card stroke `#E1701A`, a thin orange top rule, and
an orange zone-panel stroke/title), plus orange governance tiles and a legend entry. Orange = DPI 2
proposal.

### 2.1 Title / subtitle / frame (DPI 2 copies)
- `TITLE_TEXT` = `URBANI "Radar UrbiNexus" — DPI 2 Target Architecture (PROPOSED)`
- `SUBTITLE_TEXT` = `Secure multi-user control center · gray = DPI 1 delivered · orange = DPI 2 proposal (validated at kickoff) · Main/Payment ingestion depends on client access`
- `FRAME_TITLE_TEXT` unchanged: `AWS Cloud (Urbani Account · ap-south-1)`

### 2.2 New GROUPS (row 2 — orange-accent zones)
Add two zones on **row 2** so the body grows by one card band below the DPI 1 rows. Orange accent:
`fill: '#fff3e8'`, `stroke: '#E1701A'`, `color: '#9a4a06'`.

| id | row | cols | title | sub |
|---|---|---|---|---|
| `zone-e` | 2 | `[1, 3]` | `DPI 2 · Identity, Persistence & Notifications` | `(PROPOSED — validated at kickoff)` |
| `zone-f` | 2 | `[4, 6]` | `DPI 2 · Health, KPIs & Log Management` | `(PROPOSED — Main/Payment subject to client access)` |

> Note: DPI 1 zones (`zone-a`..`zone-d`) keep their existing fills/strokes (gray/neutral family as
> today). Only the new `zone-e`/`zone-f` and the DPI 2 cards carry the orange accent.

### 2.3 New NODES (row 2, placed so nothing collides)
The engine is generalized to **6 columns** (DPI 2 uses col 6 on row 2; DPI 1 rows still use 1–5).
All DPI 2 nodes get a new flag `dpi2: true` (drives the orange card stroke + top rule). Grid placement
(group = zone, col = column index), left→right across row 2:

| id | group | col | icon | title | sub | detail lines (verbatim intent) |
|---|---|---|---|---|---|---|
| `d1` | zone-e | 1 | `i-cognito` | `Amazon Cognito` | `SSO + MFA · Google Workspace (SAML/OIDC)` | `• 4 RBAC roles: Super Admin, Infra Admin,` · `  QA Operator, Reader/Auditor` · `• Fallback: JWT + TOTP MFA` |
| `d2` | zone-e | 2 | `i-ddb` | `Amazon DynamoDB (primary)` | `LIVE store · replaces SQLite` | `• Users/prefs, audit, chat+feedback, alerts` · `• Removes single-writer limit` · `• Enables 2+ ECS tasks across AZs` |
| `d3` | zone-e | 3 | `i-stream` | `DynamoDB Streams → Lambda Notifier` | `Alerts pipeline` | `• Rules by severity / service + dedup` · `(mono) Slack/Teams webhook URLs in Secrets Mgr` |
| `d4` | zone-f | 4 | `i-sns` | `Amazon SNS + Slack/Teams` | `Email + chat notifications` | `• SNS email subscription` · `• Slack and/or Teams webhook` · `• ≥ email + one of Slack/Teams (success criterion)` |
| `d5` | zone-f | 5 | `i-synth` | `CloudWatch Synthetics + Route 53` | `Health / uptime · QA, Main, Payment` | `• Canaries + Route 53 health checks` · `• Container Insights for dashboard` · `• Main/Payment MOCK until client access` |
| `d6` | zone-f | 6 | `i-logs` | `CloudWatch Logs Insights + S3` | `Full-stream search & export` | `• severity / server / date / text / regex` · `• Export CSV / JSON / PDF` · `• S3 for large exports` |

Icon symbols: reuse existing `i-ddb` for `d2`. Add new `<symbol>` defs for `i-cognito`, `i-stream`,
`i-sns`, `i-synth`, `i-logs` in the DPI 2 copy's `DEFS` (simple AWS-style rounded-tile glyphs, orange
`url(#gCompute)` or neutral fills; keep them visually in the same family as the existing icons). Each
new symbol must use a unique `id` so no existing DPI 1 symbol id is shadowed.

### 2.4 New EDGES (row 2 flow + cross-row link)
All DPI 2 edges use the existing `h-row` / `v-col` shapes (which the generalized engine resolves from the
grid). Keep every segment inside a reserved channel.

| id | from → to | shape | style | label |
|---|---|---|---|---|
| `D1` | `d1` (Cognito) → `d2` (DynamoDB) | `h-row` | solid | — |
| `D2` | `d2` → `d3` (Streams/Notifier) | `h-row` | solid | — |
| `D3` | `d3` → `d4` (SNS) | `h-row` | solid | `DynamoDB Streams → Notifier → SNS / Slack / Teams` (labelAt `gutter-above`) |
| `D4` | `d4` → `d5` (Synthetics) | `h-row` | solid | — |
| `D5` | `d5` → `d6` (Logs Insights/S3) | `h-row` | solid | — |
| `D6` | `n7` (DPI 1 DynamoDB, row 1) → `d2` (DPI 2 DynamoDB primary, row 2) | `v-col` | dashed | `Persistence migrates SQLite → DynamoDB (PROPOSED)` (labelAt `rowgutter-left` equivalent for the row-1→row-2 gutter) |

> `D6` is the one cross-row edge; it visually ties the DPI 1 alert store to the DPI 2 primary store. It
> is a `v-col` down from `n7`'s column into `d2`. **If the generalized `v-col`/label routing for a
> row-1→row-2 edge cannot be placed without a channel/collision failure within budget, DROP `D6`** (it
> is illustrative, not required) and instead convey the migration with the `zone-e` subtitle and a
> footnote — the diagram still passes and still tells the story. Try `D6` first.

### 2.5 Orange accent, legend, footnotes, governance
- **Card accent:** when `node.dpi2 === true`, render the card stroke as `#E1701A` (width 1.6) and add a
  2px orange top rule inside the card. DPI 1 cards keep `CARD_STROKE` gray. This is a render-time branch
  in `emitSvg` keyed off a `dpi2` flag carried on the card rect; it adds no new rects to the collision
  model (the top rule sits inside the already-reserved card box).
- **LEGEND:** keep the two existing arrow entries and ADD a third entry rendered as an orange swatch:
  `orange = DPI 2 proposal (validated at kickoff); Main/Payment ingestion depends on client access`.
  Legend entries live in the reserved governance footer band; adding one lengthens that band — the
  engine already sizes `govH` from the legend/footnote line counts, so this is safe.
- **GOV_TILES:** append two orange DPI 2 tiles: `Cognito — SSO/MFA` / `4 RBAC roles (PROPOSED)` and
  `SNS + Slack/Teams` / `alerts, dedup (PROPOSED)`. (Tiles are evenly spaced by count; two more is fine.)
- **FOOTNOTES:** append one DPI 2 honesty footnote, verbatim intent:
  `• DPI 2 (orange) is the PROPOSED target: Cognito/DynamoDB-as-primary/SNS-notifier/Synthetics/Logs Insights are NOT yet deployed. DPI 1 delivered SQLite + un-deployed CDK scaffolding. See docs/DPI2_PLAN_AND_GAP_ANALYSIS.md.`

### 2.6 Output file names + RASTER
- SVG: `OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.svg`
- PNG: `OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.png`
- Keep `RASTER_W = 5400` (canvas is wider/taller; density auto-derives). **Never write the DPI 1 file
  names.**

---

## 3. Engine generalization needed in the copy (N rows, N columns)

In `scripts/gen-diagram-dpi2.js` (the copy only), change the hardcoded 2-row/5-column assumptions to be
derived from the content model, so row 2 and column 6 lay out and route cleanly:

- Derive `COLS = max(NODES.map(n => n.col))` and `ROWS = max(GROUPS.map(g => g.row)) + 1`.
- Build `rowPanelY` and `cardsY` as arrays of length `ROWS`: row 0 as today; each subsequent row =
  previous row's zone bottom + `ROW_GUTTER_Y`, with `cardsY[r] = rowPanelY[r] + TITLE_BAND_H`.
- Replace `colX(5)` / `frameW` with `colX(COLS)`.
- Replace both column-channel loops to run `1..COLS`, and the inter-column gutter loop to run `1..<COLS`.
- Add a **row-gutter channel per inter-row gap** (one `ch-row{r}` spanning the full canvas width at each
  `rowGutterY[r]`) and keep the single trunk band below the last body row. `bodyBottom` = last row's zone
  bottom (plus side-panel heights where present).
- Side panels (`panel-app` row 0, `panel-users` row 1) stay on their existing rows; row 2 has no side
  panel (the DPI 2 zones span cols 1–6 and use the full frame width).
- The `h-row` edge resolver already keys `y` off the target card's group row via `cardsY[row]`, so it
  works unchanged for row 2 once `cardsY` has a row-2 entry. The `v-col` resolver works for any adjacent
  rows given correct `cardsY`.

> Keep `assertNoCollisions` and all 13 rules IDENTICAL to DPI 1. The generalization only changes how the
> grid arrays and channels are built, not the collision gate. The gate is what proves the new nodes don't
> overlap.

---

## 4. package.json script

Add, immediately after the `"gen:diagram"` line (do not reorder other scripts):

```json
"gen:diagram:dpi2": "node scripts/gen-diagram-dpi2.js",
```

---

## 5. AWS_DEPLOYMENT_GUIDE.md edits (append a DPI 2 section; keep DPI 1 intact)

Do NOT rewrite existing sections. ADD a new top-level section (e.g. `## 11. DPI 2 additions (PROPOSED —
"Radar UrbiNexus")`) after the current `## 10. Pre-deploy checklist`, plus a short pointer near the top.
Preserve the honesty framing (PROPOSED/TARGET, not deployed). Content:

1. **Lead sentence + honesty banner:** DPI 2 services are a PROPOSED target validated at kickoff; the
   delivered DPI 1 runtime is still SQLite + un-deployed CDK scaffolding. Point to
   `docs/DPI2_PLAN_AND_GAP_ANALYSIS.md` and to the DPI 2 diagram
   `OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.svg`/`.png`.
2. **Identity — Amazon Cognito (+ Google Workspace SAML/OIDC):** SSO + MFA; the 4 RBAC roles (Super
   Admin, Infrastructure Administrator, QA Operator, Reader/Auditor); documented fallback JWT + TOTP MFA.
3. **Persistence — DynamoDB as the LIVE primary store (replaces SQLite):** stores users/preferences,
   audit, chat history + feedback, alerts; removes the single-writer limit; **enables ECS Service Auto
   Scaling to ≥ 2 tasks across 2 AZs**. Cross-reference the existing §5 "Persistence (decision required)"
   note: DPI 2 commits to **option B (DynamoDB)**.
4. **Alerts/notifications pipeline:** DynamoDB Streams → Lambda Notifier → Amazon SNS (email) +
   Slack/Teams webhooks; rules by severity/service with deduplication.
5. **Health & KPIs:** CloudWatch Synthetics canaries + Route 53 health checks for QA, Main, Payment
   (Main/Payment subject to client access — label MOCK/WAITING_FOR_INTEGRATION until granted); Container
   Insights for the dashboard.
6. **Log management:** CloudWatch Logs Insights for full-stream search (severity/server/date/text/regex)
   and log/report export (CSV/JSON/PDF), with S3 for large exports.
7. **Monitoring scope:** expands from QA to Main + Payment subject to client access — label appropriately.
8. **New secrets to inject (extend §6 intent, do not edit §6 table in place):** a DPI 2 secrets note
   listing `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`, and Cognito config
   (`COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN` / issuer) — all in Secrets Manager;
   webhook URLs never sent to the browser. Do NOT touch `.env` secret values anywhere.
9. **New IAM task-role permissions (extend §7 intent):** least-privilege additions — DynamoDB
   (read/write the DPI 2 tables), SNS (publish to the alerts topic), CloudWatch Synthetics + Logs
   Insights (read) and S3 (put/get export objects). Keep "no write access to the customer's production
   app".
10. **ECS operations:** Service Auto Scaling (≥ 2 tasks across 2 AZs) unblocked once DynamoDB removes the
    single-writer limit; least-privilege Task Role as above.

Add near the top of the guide (after the intro blockquote) a one-line pointer:
`> **DPI 2 ("Radar UrbiNexus"):** proposed target additions are in §11 and in docs/DPI2_PLAN_AND_GAP_ANALYSIS.md; the DPI 2 architecture diagram is OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.svg.`

---

## 6. Honesty constraint (hard requirement — applies to BOTH deliverables)

- Diagram: orange legend note states `orange = DPI 2 proposal (validated at kickoff); Main/Payment
  ingestion depends on client access`; DPI 2 zone subtitles say `(PROPOSED …)`; a footnote states the
  DPI 2 services are NOT yet deployed and DPI 1 delivered SQLite + un-deployed CDK scaffolding.
- Docs: every DPI 2 item is framed as PROPOSED/TARGET; Main/Payment labelled subject to client access;
  no implication that Cognito/DynamoDB-notifier/Synthetics are already deployed.

---

## 7. Implementation order (dependency-ordered)

1. **Create `scripts/gen-diagram-dpi2.js`** — copy `gen-diagram.js`, generalize the grid to N rows/COLS,
   swap in the DPI 2 content model (§2), add the orange `dpi2` card branch in `emitSvg`, add the new icon
   symbols, set the DPI 2 output file names, keep `assertNoCollisions` identical.
   Files: `scripts/gen-diagram-dpi2.js` (new).
   Verify: `node scripts/gen-diagram-dpi2.js --dry-run` → prints `0 collisions`, exit 0, node count = 16.
   If any collision/channel fail appears, adjust the offending node's col/zone span or drop `D6` per
   §2.4, and re-run until `0 collisions`.

2. **Generate the DPI 2 outputs.**
   Files: `OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.svg` + `.png` (new).
   Verify: `node scripts/gen-diagram-dpi2.js` → writes both DPI 2 files, exit 0; confirm
   `OUTPUT/Urbani_AWS_Architecture_Diagram.svg`/`.png` modified-times are UNCHANGED (DPI 1 untouched).

3. **Add the npm script** (§4).
   Files: `package.json`.
   Verify: `npm run gen:diagram:dpi2` → regenerates the DPI 2 files, exit 0.

4. **Regression-check DPI 1 is untouched.**
   Files: none.
   Verify: `node --test scripts/gen-diagram.test.js` → 11/11 pass; `node scripts/gen-diagram.js --dry-run`
   → `0 collisions`, 10 nodes, exit 0 (DPI 1 behaviour unchanged).

5. **Edit `docs/AWS_DEPLOYMENT_GUIDE.md`** per §5 (append-only; DPI 1 content intact; honesty framing).
   Files: `docs/AWS_DEPLOYMENT_GUIDE.md`.
   Verify: re-read the file — new §11 present, §§1–10 unchanged, pointer line added; no DPI 1 secret
   values altered; `OUTPUT/Urbani_DPI_Documentation.pdf` and `OUTPUT/Urbani_DPI2_Plan.pdf` modified-times
   unchanged (not regenerated).

---

## 8. Full verification sequence (run from repo root)

```powershell
# 1. DPI 2 generator builds, asserts, exits 0 (16 nodes, 0 collisions)
node scripts/gen-diagram-dpi2.js --dry-run

# 2. DPI 1 regression — test suite stays green and DPI 1 generator unchanged
node --test scripts/gen-diagram.test.js
node scripts/gen-diagram.js --dry-run

# 3. Produce DPI 2 outputs via the npm script
npm run gen:diagram:dpi2

# 4. Confirm DPI 2 files exist and DPI 1 files are untouched (compare LastWriteTime before/after)
#    OUTPUT/Urbani_AWS_Architecture_Diagram_DPI2.svg + .png  -> new
#    OUTPUT/Urbani_AWS_Architecture_Diagram.svg + .png       -> unchanged
```

Expected: step 1 prints `0 collisions` and exits 0; step 2 prints `pass 11` / `fail 0` and `0 collisions`
with `nodes 10`; step 3 writes the two DPI 2 files; step 4 confirms the DPI 1 SVG/PNG and the two PDFs
are not modified.

Grep is NOT verification here — the generator's own collision gate + the unit-test suite are the
authoritative checks.

---

## 9. Gaps / assumptions

- **New icon glyphs** (`i-cognito`, `i-stream`, `i-sns`, `i-synth`, `i-logs`) are not in the DPI 1 DEFS;
  the implementer authors simple in-family SVG symbols. Assumption: hand-drawn tile glyphs are acceptable
  (the DPI 1 icons are likewise hand-drawn), no external asset needed.
- **Row-1→row-2 cross edge `D6`** is illustrative; if it cannot route cleanly within budget, drop it per
  §2.4 — the story is preserved by the zone subtitle + footnote.
- **Column 6** exists only on row 2; DPI 1 rows 0–1 keep 5 columns. The generalized channel builder
  reserves a corridor for col 6 across the whole canvas height, which is harmless (no DPI 1 card sits there).
- The exact pixel canvas size is engine-derived; no literal coordinates are introduced.
