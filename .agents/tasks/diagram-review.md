# Regenerated Urbani AWS architecture diagram — visual review of the rendered PNG

The diagram was rebuilt from a new deterministic generator (`scripts/gen-diagram.js`) that lays every
card on a fixed grid, routes all 11 edges orthogonally through reserved gutter channels, and refuses
to write output if any computed rect or segment collides. The canvas grew from 1720 × 1000 to
2702 × 1420 (PNG 5404 × 2840), and the step order now reads as a serpentine: 1→5 left-to-right across
the top row, 6→9 right-to-left across the bottom row. I reviewed the actual raster at native
resolution — four full-resolution quadrant tiles plus seven tight close-ups of the specific defect
sites — not the SVG markup.

All eight reported collisions are gone. Nothing in the render has an arrow or a line crossing glyphs,
no caption sits on a panel border, no text is clipped by a box, a frame, or the canvas edge, and no
two text blocks touch. Content is fully preserved: an independent text-run diff against the backed-up
original finds zero dropped runs and exactly two intentional additions (the new legend rows).

Watch for: nothing blocking. Two cosmetic observations only — the step-1 entry arrowhead covers the
zone-A panel border instead of passing through a cut notch the way every other border crossing does
(confirmed, cosmetic, no text affected), and the lower-right quadrant plus the right half of the
governance strip are now largely empty whitespace because the serpentine pushed steps 6–8 left
(confirmed, balance only).

**Verdict**: APPROVED

## High-level view

The serpentine layout is what actually fixes the problem class rather than the individual symptoms.
In the old figure the Guardrails→Alert-Writer edge had to travel 700 px across the canvas and back,
which is why it sliced through card text and two panel borders; now step 6 sits directly below step 5
in the same column, so that edge is one short straight vertical in its own corridor. The same
reasoning removes the dashboard→chatbot and DynamoDB→dashboard crossings: adjacent steps are adjacent
cells, so those edges are single straight segments between neighbouring columns.

Every edge label now lives in reserved channel whitespace rather than wherever the midpoint happened
to land. Three of the four long captions wrap to two or three lines to fit their channel, which is why
they clear both the arrow stroke and the panel borders they used to sit on. The human-interaction
edge (dashboard → Users) is routed through a trunk channel below every panel and below the AWS cloud
frame, which is what keeps it off the DynamoDB card and off the zone-C title.

Where an edge genuinely has to cross a group boundary — the zones are connected, so this cannot be
avoided — the crossing is perpendicular, inside a gutter, and the border stroke is cut with a port
notch so the arrow enters through a visible gap. One crossing misses that treatment: the step-1 entry
arrowhead lands on zone-A's border with no notch cut.

The collision gate behind this is real, not decorative. `assertNoCollisions()` builds its rect and
segment lists from the layout model (not by parsing the emitted SVG), evaluates 13 rules over ~10,400
pair comparisons, prints every offending pair to stderr, and calls `process.exit(1)` before
`fs.writeFileSync` is reached. I confirmed the ordering in `main()` directly.

<details>
<summary>Issues (2)</summary>

1. **Step-1 arrowhead over zone-A border** — the `App logs / metrics` arrow gets a clean notch where
   it crosses the AWS cloud frame, but its arrowhead then sits on top of zone-A's pink left border
   with no notch. Cosmetic inconsistency with the other seven crossings; cut a notch there too for
   uniformity.
2. **Empty lower-right quadrant** — the serpentine leaves the area below zone-C and the right half of
   the governance strip largely blank, so the figure reads bottom-heavy on the left. Non-blocking;
   could be tightened by shortening the governance strip or widening the footnote column.

</details>

<details>
<summary>Details</summary>

## The eight reported defects, one at a time

**D1 — Guardrails (5) → Lambda Alert Writer (6) vertical.** Gone. In the close-up of the column-5
corridor the edge leaves the bottom edge of the Guardrails card, runs straight down as a single
vertical, and terminates with its arrowhead just above the Alert Writer card's top border. It passes
through open whitespace for its entire length. It crosses exactly two borders — zone-B's bottom edge
and zone-C's top edge — and at both points the panel stroke is visibly interrupted, so the arrow
enters through a gap rather than over a line. No card body text is anywhere near it; the nearest
glyphs (`Structured JSON finding → Alert Writer (step 6)`) are roughly 100 px to its left.

**D2 — `Structured JSON finding → Alert Writer (step 6)` caption.** Gone. The caption wraps to two
lines and sits in the open row gutter between zone-B and zone-C, around (2180, 630) in SVG
coordinates. It is well clear of zone-B's bottom border above it and zone-C's top border below it,
and it does not touch its own edge stroke.

**D3 — dashed Users edge across DynamoDB text.** Gone. The edge now descends from the bottom of the
Custom Web Dashboard card, exits through notches in zone-C's bottom border and the AWS frame's bottom
border, runs left along a trunk channel below everything, then rises into the Users / Team panel. It
never enters the zone-C interior horizontally, so it comes nowhere near the DynamoDB card.

**D4 — `Engineers view alerts & insights · ask the AI chatbot (human-in-the-loop)` annotation.** Gone.
In the tight close-up the caption sits in a clean band of its own: roughly 30 px below the trunk
dashed line and 35 px above the governance strip's top border, outside every group panel. No border
passes through it and no glyph is clipped.

**D5 — zone-C title struck through.** Gone. `Alert Storage & Custom Visualization` sits alone in the
panel's reserved title band at the top-left of the green panel. The only edge that enters zone-C from
above is the step-5→6 vertical, which crosses the border at the far right of the panel, around
x = 2165 in the tile, well clear of the title text.

**D6 — `App logs / metrics` over the AWS frame.** Gone. The two-line label sits entirely to the left
of the frame's dashed border, in the entry gutter between the Application / Services panel and the
cloud frame, with roughly 240 px of clearance to the frame edge. The arrow itself crosses the frame
through a clearly visible notch in the dashed stroke.

**D7 — Custom Web Dashboard → AI Chatbot through a panel border.** Gone as a text/line conflict. The
edge is one straight horizontal at the cards' mid-height. It crosses zone-C's left border and
zone-D's right border, and both strokes show a cut notch at the crossing point, so the arrow passes
through a gap. Its arrowhead stops just short of the AI Log Chatbot card's right edge. No glyph is
touched on either side.

**D8 — `Dashboard queries DynamoDB alerts + LIVE logs API` caption.** Gone. The caption wraps to three
lines and sits in the column gutter between the Dashboard and DynamoDB cards, above the dashed edge.
Measured on the native-resolution crop it clears the Dashboard card's right border by about 28 px,
the DynamoDB card's left border by about 60 px, and its own edge stroke by about 50 px. It no longer
sits inside or across a container border.

## Whole-image sweep for anything else

Across all four native-resolution quadrants no line, arrow, arrowhead, or border touches a glyph, no
text block abuts another, and nothing is clipped by a card, a panel, the cloud frame, or the canvas
edge. The step badges overlap only their icon tiles. Bedrock's longer detail lines
(`• Suggests root cause + recommendations`, `temp 0.0 · max_tokens 1024 · Nova fallback`) wrap inside
the card instead of overflowing it, which is what the original was shrinking font sizes to 8.5 px to
avoid. Every row-1 inter-zone crossing (Lambda Collector → Bedrock, Bedrock → Guardrails) passes
through cut notches at card mid-height. In the governance strip the six tiles, the two new legend
rows, and both footnote bullets each sit on their own baseline, and the longest footnote ends well
inside the strip's right edge. The API Gateway card correctly carries no step badge.

Two things I would call out beyond the eight defects, neither of which hides text. The step-1 entry
arrow gets a proper notch where it crosses the AWS cloud frame, but its arrowhead then lands on
zone-A's pink left border with no notch cut there — confirmed on a 280 × 170 native crop; it reads
cleanly only because the arrowhead is an opaque triangle. And the region below zone-C plus the right
half of the governance strip are now largely empty, a side effect of the serpentine pulling steps 6–8
toward the left, so the figure reads bottom-heavy on the left.

## Content preservation

I ran my own text-run extraction over both the backed-up original
(`OUTPUT/_originals_backup/Urbani_AWS_Architecture_Diagram.svg`) and the regenerated SVG rather than
relying on the coder's count. Original: 106 text runs. New: 113. Every one of the 106 original runs is
present in the new file, allowing for runs that are now split across two rendered lines by wrapping.
Nothing was dropped, renamed, or reworded — no node, bullet, badge, group title, footnote, or edge
label is missing.

The only additions are the two legend rows, `solid arrow = automated data flow` and
`dashed arrow = human interaction / query`, which the plan called for explicitly. The one stylistic
change worth recording: monospace detail lines that the original shrank to 8.5–10.5 px to force a fit
are now a uniform 12 px, because the boxes are sized to the text instead of the reverse. That is why
the cards read as legible at 100 % zoom.

## Out of scope, carried forward

`scripts/gen-proposal.js` and `scripts/gen-deck.js` still embed the PNG at the old hardcoded aspect
ratios (1.72 and 2.08 against the new 1.90), so the figure is slightly stretched inside the generated
`.docx` and `.pptx`. The coder flagged this deliberately as plan item 9, outside this task's scope. It
does not affect the PNG under review, but the embedded copies will not look as clean as the standalone
figure until those two numbers are updated.

</details>

<details>
<summary>Evidence inspected</summary>

- `OUTPUT/Urbani_AWS_Architecture_Diagram.png` — 5404 × 2840, 0.80 MB; reviewed as four native-resolution
  quadrant tiles (2702 × 1420 each) plus close-ups of the column-5 corridor, the dashboard/DynamoDB
  gutter, the entry gutter at the frame, the trunk channel, the row-1 panel crossings, the trunk
  caption band, and two arrowhead/border contact points.
- `.agents/tasks/diagram-verification.md` and `.agents/tasks/diagram-plan.md` — the coder's recorded
  generator run (exit 0, `0 collisions`, idempotent on re-run, 11/11 unit tests) and layout model.
- `scripts/gen-diagram.js` — spot-checked `main()` and `assertNoCollisions()` to confirm the gate runs
  before any write and exits non-zero on failure.
- Independent text-run diff of the new SVG against `OUTPUT/_originals_backup/…svg`.

</details>
