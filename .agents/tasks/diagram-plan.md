# Implementation Plan — Rebuild the Urbani AWS architecture diagram with a deterministic, collision-checked generator

Goal: replace the hand-authored `OUTPUT/Urbani_AWS_Architecture_Diagram.svg` with output from a new
`scripts/gen-diagram.js` that lays everything on a fixed grid, routes all edges orthogonally through
reserved gutter channels, and refuses to write output if any text, label, box, or edge segment
collides. User-visible requirement: **nothing overlaps** — no arrow crosses text, no caption sits on
a panel border, no label is cut by a frame.

---

## 0. Exploration findings (facts the implementer can rely on)

Repo conventions, read from the actual files:

- No `AGENTS.md`, no `CONTRIBUTING.md`, no `.kiro/steering/`. `README.md` documents the product and
  the npm-workspaces layout; it says nothing about diagram assets. So the only conventions to follow
  are the ones visible in `scripts/*.js`.
- `scripts/` holds three generators: `gen-deck.js`, `gen-plan.js`, `gen-proposal.js`. All are
  **CommonJS** (`require`), 2-space indent, single quotes, semicolons, a `/* ... */` file-header
  comment on line 1 stating exactly which OUTPUT file is produced, `const OUT = path.join(__dirname,
  '..', 'OUTPUT');`, UPPER_CASE colour constants, `// --- Section ---` separators, and a single
  terminal `console.log('Wrote ' + path.basename(f))`. They are run directly (`node
  scripts/gen-deck.js`) — root `package.json` has **no** `gen:*` npm scripts, so do not add one.
- Root `package.json`: npm workspaces, `engines.node >= 18`, devDependencies `docx ^9.8.1`,
  `pptxgenjs ^4.0.1`, `sharp ^0.35.5`. Installed Node is **v24.13.0**, so the built-in test runner
  (`node --test <file>`) and `node:test` / `node:assert` are available with no new dependency.
  Verified working on this machine.
- `sharp` loads from root `node_modules` and reads the current PNG as **5733 × 3333, density 240**,
  i.e. the existing PNG is the 1720 × 1000 SVG rasterised at `density: 240` (1720 × 240/72 = 5733).
  That is the rasterisation recipe to reuse.
- Two consumers embed the PNG, both with hardcoded dimensions:
  - `scripts/gen-proposal.js` line ~53: `transformation: { width: 620, height: 360 }` (aspect 1.72 —
    matches today's canvas).
  - `scripts/gen-deck.js` line ~49: `s.addImage({ ..., w: 12.5, h: 6.0 })` (aspect 2.08 — already
    stretches the figure).
  Changing the canvas aspect therefore requires touching both (item 9).
- `OUTPUT/_originals_backup/` exists and holds the three September originals. It does **not** yet
  hold a diagram backup — the current SVG/PNG must be copied in before overwrite.
- `.gitignore` does not ignore `.agents/`. This plan file is scratch; do not commit `.agents/`.

Running `node --test` from the repo root picks up unrelated backend tests that currently fail, so all
verification commands below name the test file explicitly.

---

## 1. Content inventory extracted verbatim from the current SVG

Nothing below may be invented, reworded, or dropped. Text is reproduced exactly as it appears
(`&amp;` decoded to `&`; re-encode on emit).

### 1.1 Canvas-level text

- Title (26px, 800, `#16191f`): `URBANI — Proactive Observability & AI Troubleshooting Assistant`
- Subtitle (14px, `#6b7480`): `Target AWS Architecture · Custom Web Dashboard + AI Log Chatbot · Read-only · Evidence-based · Human-in-the-loop · 5-minute loop`

### 1.2 Groups / panels (7 + the cloud frame)

| id | title | subtitle | fill / stroke / title colour |
|---|---|---|---|
| `panel-app` | `Application / Services` | `(Existing — Urbani)` | `#f7f9fc` / `#c7d0e0` / `#232f3e` |
| `frame-aws` | `AWS Cloud (Urbani Account · ap-south-1)` + `aws` smile logo | — | `#fcfdff` / `#232f3e` dashed `8 6` / `#232f3e` |
| `zone-a` | `Monitoring & Log Collection` | `(every 5 minutes)` | `#fdeff3` / `#f3bdcc` / `#be0f5e` |
| `zone-b` | `AI Analysis & Alert Processing` | — | `#e7f6f1` / `#a3dcc7` / `#00857a` |
| `zone-c` | `Alert Storage & Custom Visualization` | — | `#eef7ea` / `#bee0ab` / `#4a8a2c` |
| `zone-d` | `AI Log Chatbot & Live Feed` | — | `#fff6e5` / `#e7cf92` / `#9c6f08` |
| `panel-users` | `Users / Team` | — | `#f7f9fc` / `#c7d0e0` / `#232f3e` |
| `strip-gov` | `Cross-cutting Governance & Key Configuration` | — | `#f7f9fc` / `#c7d0e0` / `#232f3e` |

### 1.3 `panel-app` items (icon + name + sub, no badges, no bullets)

1. `#i-ebapp` — `Elastic Beanstalk` / `urbani-app (primary)`
2. `#i-ec2` — `EC2 / ECS / EKS` / `apps & containers`
3. `#i-lam2` — `Lambda apps` / `serverless services`
4. `#i-rds` — `RDS / data stores` / `databases`
5. `#i-cloud` — `Other AWS services` / `future scope`

### 1.4 Node cards (10) — badge, title, subtitle, bullet lines verbatim

`mono` = Consolas/Courier monospace class; `•` prefixes are part of the rendered line.

| badge | group | icon | title | subtitle | detail lines |
|---|---|---|---|---|---|
| 1 | zone-a | `#i-cw` | `Amazon CloudWatch` | `Logs & Metrics` | `• Application / system logs` · `• Metrics · 30-day retention` · *(mono)* `/aws/elasticbeanstalk/urbani-app` |
| 2 | zone-a | `#i-eb` | `EventBridge` | `Scheduler · rate(5m)` | `• Fires every 5 minutes` · `• 288 runs / day` · `• Bounds token cost` |
| 3 | zone-a | `#i-lambda` | `Lambda Collector` | *(mono)* `UrbaniTelemetryCollectorFn` | `• CloudWatch Insights query` · `• Filters errors / exceptions` · `• Max 100 log lines` |
| 4 | zone-b | `#i-bedrock` | `Amazon Bedrock` | `Claude 3.5 Sonnet v2 · LLM analysis` | `• Analyzes log patterns · cites evidence` · `• Suggests root cause + recommendations` · *(mono)* `temp 0.0 · max_tokens 1024 · Nova fallback` |
| 5 | zone-b | `#i-guard` | `Bedrock Guardrails` | `Safety & compliance` | `• PII redaction · injection defense` · *(mono)* `urbani-dpi-guardrail-v1` · *(mono)* `NO_ANOMALY_DETECTED if none` |
| 6 | zone-c | `#i-lambda` | `Lambda Alert Writer` | *(mono)* `UrbaniAlertWriterFn` | `• Validates strict JSON` · `• Formats UrbaniIncidentAlert` · `• Writes to DynamoDB` |
| 7 | zone-c | `#i-ddb` | `Amazon DynamoDB` | `UrbaniAlerts · KMS encrypted` | *(mono)* `PK service_id · SK timestamp` · *(mono)* `GSI anomaly_type-index` · `• Alert history & pattern memory` |
| 8 | zone-c | `#i-dash` | `Custom Web Dashboard` | `React SPA + Node API · nginx` | `• KPIs · alerts · logs · metrics` · `• Reads DynamoDB + LIVE logs` · `• NOT Grafana / CloudWatch dash` |
| 9 | zone-d | `#i-chat` | `AI Log Chatbot` | `"Ask about the logs"` | `• Natural-language Q&A over logs` · `• Evidence-grounded · cites lines` · `• Advisory only` |
| *(none)* | zone-d | `#i-apigw` | `API Gateway` | `LIVE logs · x-api-key` | `• Real Urbani logs (5-min)` · `• Read-only, secured` · *(mono)* `/logs/latest` |

Badge style: `circle r=13 fill #232f3e`, number 13px/800 white, centred — currently pinned to the
icon's top-left corner.

### 1.5 `panel-users` content

Three `#i-user` avatars labelled `Operations`, `Development`, `Support`, plus a two-line caption:
`Step 10 · Engineers review evidence,` / `chat with the assistant, apply fix (manual)`.

### 1.6 `strip-gov` content

Six mini tiles, each bold line + sub line:

1. `#g-iam` — `IAM — least privilege` / `read-only exec role`
2. `#g-kms` — `KMS — encryption` / `at rest everywhere`
3. `#g-trail` — `CloudTrail — audit` / `all API calls`
4. `#g-budget` — `AWS Budgets` / `$50 / $100 alerts`
5. `#g-guard` — `Guardrails` / `PII + injection defense`
6. `#g-cdk` — `AWS CDK IaC` / `all resources`

Two footnote bullets (12px `#46505b`), verbatim:

- `• Visualization is a CUSTOM WEB DASHBOARD + AI Log Chatbot (React SPA + Node API behind nginx) — NOT Amazon Managed Grafana or CloudWatch dashboards.`
- `• Live logs integrated via API Gateway (/logs/latest, x-api-key). Metrics / services / alerts remain MOCK until endpoints are provisioned. MVP is READ-ONLY, human-in-the-loop.`

### 1.7 Edges (11) and their labels

Solid = `#2f3742`, width 2.6, marker `#ah`. Dashed = `#8a94a6`, width 2, `stroke-dasharray 6 5`,
marker `#ahg`.

| id | from → to | style | label |
|---|---|---|---|
| E1 | `panel-app` → node 1 CloudWatch | solid | `App logs` / `/ metrics` (two lines today) |
| E2 | node 1 → node 2 | solid | — |
| E3 | node 2 → node 3 | solid | — |
| E4 | node 3 → node 4 Bedrock | solid | — |
| E5 | node 4 → node 5 Guardrails | solid | — |
| E6 | node 5 Guardrails → node 6 Alert Writer | solid | `Structured JSON finding → Alert Writer (step 6)` |
| E7 | node 6 Alert Writer → node 7 DynamoDB | solid | — |
| E8 | node 8 Dashboard → node 9 AI Log Chatbot | solid | — |
| E9 | API Gateway → node 9 AI Log Chatbot | dashed | — |
| E10 | node 7 DynamoDB → node 8 Dashboard | dashed | `Dashboard queries DynamoDB alerts + LIVE logs API` |
| E11 | node 8 Dashboard → `panel-users` | dashed | `Engineers view alerts & insights · ask the AI chatbot (human-in-the-loop)` |

### 1.8 Legend

**There is no legend in the current SVG.** Decision: add a minimal two-row legend
(`solid arrow = automated data flow`, `dashed arrow = human interaction / query`) in the reserved
footer band left of the governance strip's footnotes. Rationale: dashed vs solid already carries
meaning in the diagram and is currently unexplained; two short rows in reserved whitespace cost
nothing and cannot collide because they are placed by the same grid engine.

### 1.9 Visual language to preserve exactly

Rounded group panels with pastel fill + matching coloured border; rounded white node cards with a
coloured gradient icon tile (gradients `gCompute` `gMgmt` `gML` `gSec` `gDb` — copy the five
`linearGradient` defs verbatim); dark circular numbered step badges; the hand-drawn `aws` smile
symbol; all 20 `<symbol>` icon defs copied verbatim; the `<style>` classes `nname nsub mono blt
ztitle zsub ptitle psub flow`; solid dark arrows for machine data flow, dashed grey arrows for
human/query interaction; white page background `#ffffff`.

---

## 2. The 8 known defects this rebuild must eliminate

The reviewer checks each one by eye on the regenerated PNG, and the generator's assertion pass must
make each one structurally impossible.

| # | Defect in the current SVG | Structural fix |
|---|---|---|
| D1 | Long vertical `Guardrails → Alert Writer` arrow (`M1382 306 V460 H690 V524`) cuts through neighbouring bullet text and two panel borders. | Serpentine layout puts Alert Writer directly below Guardrails in the same grid column; E6 becomes one short vertical inside the column corridor + the reserved row channel. |
| D2 | Caption `Structured JSON finding → Alert Writer (step 6)` sits on top of a panel boundary. | Edge labels are placed only in reserved channel whitespace, with an opaque background rect, and are assertion-checked against every border-adjacent text rect. |
| D3 | Dashed arrow from `Users / Team` crosses DynamoDB body text. | E11 is routed in the trunk channel **below** every group panel; no segment enters a card's text area. |
| D4 | `Engineers view alerts & insights…` annotation overlaps a panel border and the `Alert Storage & Custom Visualization` title. | Same trunk channel; label centred in the channel's reserved label sub-band, outside all panels. |
| D5 | That same zone-C title is struck through by a downward arrow. | Group title band is reserved: no node, no label, and no edge segment may enter it (assertion). |
| D6 | `App logs / metrics` edge label overlaps the outer AWS cloud frame near Elastic Beanstalk. | Wide entry gutter (180px) between the side column and the AWS frame; the label occupies the sub-band left of the frame edge, and the frame crossing uses a port notch. |
| D7 | `Custom Web Dashboard → AI Chatbot` arrow passes through a panel border. | Inter-group edges cross borders only perpendicular, inside a reserved gutter, through a **port notch** (a border-coloured gap painted over the stroke) so the arrow enters through a gap instead of over the line. |
| D8 | `Dashboard queries DynamoDB alerts + LIVE logs API` sub-box caption overlaps surrounding text and its own container border. | E10 becomes a straight horizontal between adjacent columns; its label sits in the column gutter with an opaque rect, assertion-checked. |

---

## 3. Design decisions (made here, not left to the implementer)

1. **Serpentine (boustrophedon) flow.** Row 1 runs left→right (1 CloudWatch, 2 EventBridge,
   3 Collector, 4 Bedrock, 5 Guardrails); row 2 runs right→left (6 Alert Writer, 7 DynamoDB,
   8 Dashboard, 9 Chatbot, API Gateway). Rationale: every one of E2–E10 becomes either a straight
   horizontal between adjacent columns or a single straight vertical in one column corridor, so the
   step order 1→9 reads as one continuous snake and there are **zero** edge crossings to resolve.
   This alone kills D1, D7 and D8.
2. **Two side panels in a dedicated left column.** `panel-app` in row 1, `panel-users` in row 2,
   both outside the AWS cloud frame. Keeps E1 and E11 short and keeps the frame crossing to one
   notch each.
3. **Uniform grid, row height = max measured card height in that row.** Column widths and gutters
   are constants; card height is measured from wrapped text, then every card in a row is set to the
   row max. Rationale: satisfies "uniform row heights" while guaranteeing no card ever clips its own
   text.
4. **Port notches instead of arrows drawn over borders.** When an edge must cross a group border, the
   generator paints a short rect in the border's local fill colour over the stroke at the crossing
   point. Rationale: D7 explicitly flags border crossings; a notch makes the crossing read as an
   intentional port.
5. **Text metrics by table, not by measurement.** No font-measuring dependency is available, so:
   monospace uses the exact Consolas advance `0.55em`; proportional (Segoe UI) uses a per-character
   ratio table (narrow `iljt.,:;'!|` ≈ 0.28em, digits/lowercase ≈ 0.52em, uppercase ≈ 0.66em, `MW` ≈
   0.84em, space 0.26em) plus a **6% safety margin**. Rationale: over-estimating width can only make
   boxes roomier, never clipped.
6. **Canvas grows to fit.** Target ≈ **2180 × 1420** (vs today's 1720 × 1000). Larger viewBox is
   strictly better than cramped; both consumers scale the raster anyway.
7. **Raster width ≈ 5400 px** via `sharp(svgBuffer, { density: Math.round(72 * 5400 / canvasWidth) })`,
   matching today's ~5733 px / 1.4 MB. Rationale: keeps the embedded figure sharp without inflating
   the docx/pptx.
8. **`module.exports` + `if (require.main === module)` guard.** A deliberate deviation from the other
   three generators (which run on import) so the geometry helpers are unit-testable with `node --test`.
9. **Collision assertion is a hard gate**, not a warning: offending pairs to `stderr`, then
   `process.exit(1)`, before any file is written.

---

## 4. Layout model the generator must implement

**Grid.** Constants at the top of the file (`const LAYOUT = { ... }`), all geometry derived from them:

```
MARGIN        = 40
SIDE_COL_W    = 300            // col0: panel-app / panel-users
ENTRY_GUTTER  = 180            // col0 -> col1; holds the E1 label and the frame crossing
COL_W         = 260            // cols 1..5, uniform
GUTTER_X      = 72             // between cols 1..5, uniform; each is a vertical routing channel
GROUP_PAD     = 22             // panel inner padding around its cards
FRAME_PAD     = 24             // AWS frame padding around the zone panels
TITLE_BAND_H  = 52             // reserved band at the top of every group panel
FRAME_TITLE_H = 56             // reserved band for the aws logo + cloud label
HEADER_H      = 130            // canvas title + subtitle band
ROW_GUTTER_Y  = 120            // horizontal routing channel between node rows
TRUNK_H       = 110            // channel below all panels, reserved for E11
GOV_H         = 170            // governance strip + footnotes + legend
CARD_PAD      = 16             // card inner padding
CLEARANCE     = 6              // min gap enforced between an edge segment and any text rect
```

Derived (recompute, do not hardcode): `col(i).x`, `row(j).y`, panel rects from the span of columns
they contain, canvas `width/height` from the right/bottom extents + `MARGIN`.

**Cards snap to cells.** Card width = `COL_W`. Inner text width = `COL_W - 2*CARD_PAD`. Card layout
top→bottom: icon tile 64 (badge circle centred on its top-left corner, fully inside the card), title
(`nname`), subtitle (`nsub`, wrapped), then detail lines (`blt`, wrapped to at most 2 visual lines
each). Height = sum of measured line boxes + padding; then raised to the row max.

**Channels.** Every gutter is a named channel. A vertical channel is the full-height strip of
`GUTTER_X` between two columns; a horizontal channel is `ROW_GUTTER_Y` or `TRUNK_H`. Each channel
reserves a **label sub-band** (the half of the channel on the side away from the arrow centre-line)
so a label never shares pixels with its own segment's arrowhead.

**Routing.** Orthogonal only. Each edge gets explicit ports (`right`, `left`, `top`, `bottom`,
mid-edge of the source/target rect). Allowed shapes, in preference order:
1. straight horizontal/vertical in the corridor directly between the two ports (E2–E5, E7–E10);
2. one vertical in a column corridor + the row channel (E6);
3. port → trunk channel → horizontal → port (E11, E1 via the entry gutter).
Every segment must lie entirely inside a gutter channel, a trunk channel, or the straight corridor
between the two ports it connects. Any other shape is a bug.

**Group titles.** Rendered in `TITLE_BAND_H` at the panel's top-left. No card, label, or edge
segment may enter the title band (asserted).

**Edge labels.** Each label is a text run with a measured rect plus an opaque background rect
(`fill` = the channel's underlying fill colour, `rx 4`, 6px padding) placed at the segment midpoint,
offset into the channel's label sub-band. If the measured label exceeds the channel's free width, it
wraps to two lines before anything else is tried.

---

## 5. Collision assertion pass (must run before any write)

Build two arrays from the layout model (never by parsing the emitted SVG string):

- `rects`: `{ id, kind, x, y, w, h, ownerId }` for every node card, every text **line** box (card
  title/sub/details, panel titles, group titles, side-panel item labels, governance tile lines,
  footnotes, legend rows, canvas title/subtitle), every edge-label box (text + background), every
  group title band, every group panel, and the badge circles' bounding boxes.
- `segments`: `{ edgeId, x1, y1, x2, y2, fromId, toId }` for every orthogonal segment of every edge,
  including the arrowhead's bounding box as a small rect.

Assertions (each failure appends to a list; all failures are reported, not just the first):

1. `text × text` — no two text/label rects may intersect.
2. `text × card` — a text rect may not intersect a node card other than its owner.
3. `card × card` — no two node cards may intersect.
4. `card × panel` — a card must be fully inside its own group panel and must not intersect any other
   panel.
5. `segment × text` — no segment may intersect any text/label rect inflated by `CLEARANCE`.
6. `segment × card` — no segment may intersect a card other than its own `fromId` / `toId`.
7. `segment × title band` — no segment may enter any group title band.
8. `segment × segment` — no two segments from different edges may cross (they may touch only at a
   shared port).
9. `label × panel border` — no label rect may straddle a panel border line (border inflated by
   `CLEARANCE`).
10. every rect must be inside the canvas minus `MARGIN`.

On failure: print one line per offending pair to `stderr` in the form
`COLLISION [rule 5] edge E6 seg(1382,306)-(1382,460) × text "• PII redaction · injection defense" @(1350,360,228,16)`,
print the total count, then `process.exit(1)`. On success: print the counts
(`rects`, `segments`, pair comparisons, `0 collisions`) and continue to emit.

Flags: `--dry-run` (model + layout + assertions, no file writes), `--debug` (also writes
`OUTPUT/_debug_diagram_overlay.svg` with every rect stroked magenta and every segment cyan, for
eyeballing the channels — a scratch file, do not commit it).

---

## 6. Ordered implementation items

- [ ] 1. Back up the current diagram assets before anything can overwrite them. Copy
      `OUTPUT/Urbani_AWS_Architecture_Diagram.svg` and `.png` into `OUTPUT/_originals_backup/`
      (keep the same file names; that directory already holds the other September originals).
      Files: `OUTPUT/_originals_backup/Urbani_AWS_Architecture_Diagram.svg`,
      `OUTPUT/_originals_backup/Urbani_AWS_Architecture_Diagram.png`
      Verify: `node -e "const fs=require('fs');['svg','png'].forEach(e=>{const a='OUTPUT/Urbani_AWS_Architecture_Diagram.'+e,b='OUTPUT/_originals_backup/Urbani_AWS_Architecture_Diagram.'+e;if(fs.statSync(a).size!==fs.statSync(b).size)throw new Error(e);});console.log('backup ok')"`
      — prints `backup ok`.

- [ ] 2. Create `scripts/gen-diagram.js` with the file-header comment, the CommonJS skeleton matching
      `gen-deck.js` style, the full content model from section 1 as plain data (`GROUPS`, `NODES`,
      `SIDE_ITEMS`, `EDGES`, `GOV_TILES`, `FOOTNOTES`, `LEGEND`), the `LAYOUT` constants from
      section 4, the text-metrics helpers (`charWidth`, `textWidth`, `wrapText`), `module.exports`,
      and the `require.main === module` guard. At this stage `--dry-run` prints an inventory summary.
      Files: `scripts/gen-diagram.js`
      Verify: `node scripts/gen-diagram.js --dry-run` exits 0 and prints
      `nodes 10 · side items 5 · groups 8 · edges 11 · gov tiles 6 · footnotes 2` (counts must match
      section 1 exactly — 10 node cards including the badge-less API Gateway).

- [ ] 3. Add the geometry + collision primitives to the same file (`rectsIntersect`, `inflate`,
      `segmentIntersectsRect`, `segmentsCross`, `rectOfTextLine`) and cover them with unit tests
      using the built-in runner, including a known-overlapping pair that must be detected and a
      touching-at-a-port pair that must not be flagged.
      Files: `scripts/gen-diagram.js`, `scripts/gen-diagram.test.js`
      Verify: `node --test scripts/gen-diagram.test.js` — all tests pass (do not run bare
      `node --test` from the root; it also collects failing backend tests).

- [ ] 4. Implement the grid layout engine: columns (`col0` side column, `col1..col5`), the two node
      rows with `height = max measured card height`, group panel rects derived from their column
      spans, reserved title bands, the AWS frame, the trunk channel, and the governance strip. Cards
      snap to cells and wrap their own text. Extend `--dry-run` to print a bounds table
      (`id x y w h`) plus the computed canvas size.
      Files: `scripts/gen-diagram.js`
      Verify: `node scripts/gen-diagram.js --dry-run` exits 0, prints a canvas near 2180×1420, and
      every node card's bounds are fully inside its group panel (the printed table makes this
      checkable); `node --test scripts/gen-diagram.test.js` still passes.

- [ ] 5. Implement the orthogonal router: port assignment per edge, the three allowed path shapes
      from section 4, channel ownership so two edges never share a channel lane, port notches at
      group/frame crossings, and label placement in channel label sub-bands with opaque background
      rects. E6 must come out as a single vertical in the col-5 corridor; E1 and E11 use the entry
      gutter and the trunk channel.
      Files: `scripts/gen-diagram.js`
      Verify: `node scripts/gen-diagram.js --dry-run` prints each edge's segment list and every
      segment is axis-aligned (dx === 0 || dy === 0) — add that as a thrown check in the router so a
      non-orthogonal segment fails the run.

- [ ] 6. Implement the assertion pass of section 5 (all 10 rules, full offender list to `stderr`,
      `process.exit(1)` on any failure, counts on success) and the `--debug` overlay writer. Prove
      the detector actually bites: temporarily shift one node card by `-COL_W/2`, confirm the run
      exits non-zero and names the colliding pairs, then revert the shift.
      Files: `scripts/gen-diagram.js`
      Verify: `node scripts/gen-diagram.js --dry-run` exits 0 with `0 collisions`; with the temporary
      perturbation it exits 1 and lists `COLLISION` lines. `node --test scripts/gen-diagram.test.js`
      still passes.

- [ ] 7. Implement SVG emission and write `OUTPUT/Urbani_AWS_Architecture_Diagram.svg`. Copy the
      `<defs>` block of the current SVG verbatim (the five gradients, both arrow markers, the
      `aws-logo` symbol, all 20 service/governance/user symbols, the `<style>` classes), then render
      from the layout model: background, header text, panels + title bands, cards + icon tiles +
      badges + wrapped text, governance strip, footnotes, legend, port notches, edges, edge labels.
      Escape `&`, `<`, `>` in all text. Emission must read coordinates only from the layout model.
      Files: `scripts/gen-diagram.js`, `OUTPUT/Urbani_AWS_Architecture_Diagram.svg`
      Verify: `node scripts/gen-diagram.js` exits 0, prints `0 collisions` then
      `Wrote Urbani_AWS_Architecture_Diagram.svg`; `node -e "const s=require('fs').readFileSync('OUTPUT/Urbani_AWS_Architecture_Diagram.svg','utf8');['Amazon CloudWatch','Bedrock Guardrails','UrbaniTelemetryCollectorFn','NOT Grafana / CloudWatch dash','/logs/latest','Step 10 · Engineers review evidence,'].forEach(t=>{if(!s.includes(t))throw new Error('missing '+t)});console.log('content ok')"`
      prints `content ok` (content-completeness check, not a substitute for the collision gate).

- [ ] 8. Rasterise to PNG with `sharp` at the density that yields ≈5400 px width, and finish with the
      `console.log('Wrote ' + path.basename(f))` convention used by the other generators (one line
      per written file).
      Files: `scripts/gen-diagram.js`, `OUTPUT/Urbani_AWS_Architecture_Diagram.png`
      Verify: `node scripts/gen-diagram.js` exits 0 and
      `node -e "require('sharp')('OUTPUT/Urbani_AWS_Architecture_Diagram.png').metadata().then(m=>console.log(m.width,m.height,(require('fs').statSync('OUTPUT/Urbani_AWS_Architecture_Diagram.png').size/1048576).toFixed(2)+'MB'))"`
      reports a width near 5400, the matching aspect, and a size in the ~1–3 MB range.

- [ ] 9. Refresh the two consumers so the new figure is not stretched, then regenerate the OUTPUT
      documents. Update `scripts/gen-proposal.js` `transformation` to `{ width: 620, height:
      Math.round(620 / aspect) }` and `scripts/gen-deck.js` `addImage` to keep `w: 12.5` with
      `h: +(12.5 / aspect).toFixed(2)` (aspect from item 8; both currently hardcode the old 1.72 /
      2.08 ratios).
      Files: `scripts/gen-proposal.js`, `scripts/gen-deck.js`,
      `OUTPUT/Urbani_AWS_Architecture_Proposal.docx`, `OUTPUT/Urbani_AWS_Architecture_v3.pptx`
      Verify: `node scripts/gen-proposal.js` and `node scripts/gen-deck.js` each exit 0 and print
      their `Wrote …` line; both OUTPUT files have a fresh mtime and a non-zero size.

- [ ] 10. Visual QA. Open `OUTPUT/Urbani_AWS_Architecture_Diagram.png` and walk the D1–D8 table in
      section 2, confirming each named defect is gone, plus: no arrow touches any glyph, every
      caption sits in clear space with its background rect, no label is clipped by the AWS frame or a
      panel border, the 1→9 badge order reads as a left-to-right then right-to-left snake, and all
      text from section 1 is present and legible. Delete `OUTPUT/_debug_diagram_overlay.svg` if
      `--debug` was used.
      Files: none (inspection only)
      Verify: `node scripts/gen-diagram.js` is re-runnable and idempotent (second run also exits 0
      with `0 collisions`), and the PNG shows no overlap at 100% zoom.

---

## 7. Gaps and assumptions

- **No legend existed**; one is being added (section 1.8). If the reviewer considers that new content,
  it can be dropped by removing the `LEGEND` array — the layout engine simply reclaims the space.
- **Font metrics are estimated**, so a rendered glyph could in theory extend ~1–2 px beyond its
  computed box. The 6% safety margin plus `CLEARANCE = 6` absorbs this; the assertion is on computed
  boxes, not rasterised glyphs, and that is the accepted limit of this approach.
- **`CLEARANCE = 6` is a judgement call.** If the visual QA in item 10 still reads as tight, raise it
  in `LAYOUT` and re-run; the canvas grows automatically.
- **Edges crossing group borders cannot be eliminated** (the zones are genuinely connected). The port
  notch is the chosen treatment, so the assertion deliberately permits a perpendicular
  segment × panel-border crossing inside a reserved gutter while still forbidding any text contact.
- **`.agents/` is scratch** and is not in `.gitignore`; it must not be committed.
