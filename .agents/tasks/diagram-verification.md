# Verification note — `scripts/gen-diagram.js` (iteration 1)

Everything below was actually run in `c:\Antigravity\Urbani DPI`. The reviewer should not need to
re-run the generator; the figure to review is `OUTPUT/Urbani_AWS_Architecture_Diagram.png`.

## Commands run and results

| Command | Result |
|---|---|
| `Copy-Item` backup of SVG + PNG into `OUTPUT/_originals_backup/` | both present, byte-identical to the pre-change originals (22,846 B SVG / 1,385,526 B PNG) |
| `node scripts/gen-diagram.js --dry-run` | exit **0**, `0 collisions`, no files written |
| `node scripts/gen-diagram.js` | exit **0**, `0 collisions`, then `Wrote Urbani_AWS_Architecture_Diagram.svg` + `Wrote Urbani_AWS_Architecture_Diagram.png` |
| `node scripts/gen-diagram.js` (second run) | exit **0**, `0 collisions` — idempotent |
| `node --test scripts/gen-diagram.test.js` | 11 tests, **11 pass / 0 fail** |

Generator console summary on the committed run:

```
Inventory: nodes 10 · side items 5 · groups 8 · edges 11 · gov tiles 6 · footnotes 2
Canvas: 2702 x 1420 (col width 262, card height 234)
Checked: rects 161 (inked 101, cards 10, panels 7) · segments 13 · arrowheads 11 · labels 4 · 10408 pair comparisons
0 collisions
```

## Canvas / raster

- SVG `viewBox` = **0 0 2702 1420** (was 1720 × 1000). Aspect 1.903.
- PNG = **5404 × 2840**, 0.80 MB, rasterised by `sharp` at `density: 144` (= 72 × 5400 / 2702), ≈2x.
- Column width 262, uniform inter-column gutter 172, uniform card height 234, uniform row heights.

## The collision gate is real, not a stub

`assertNoCollisions()` builds the rect/segment lists from the layout model (never by parsing the
emitted SVG) and evaluates 13 rules over 10,408 pair comparisons: text×text, badge×text, text×card,
card×card, card-inside-its-own-panel, segment×text (inflated by `CLEARANCE = 7`), arrowhead×text,
segment×card, segment×title-band, segment×segment, label×panel-border, in-canvas, and
segment-inside-a-reserved-channel. Every failure is printed to stderr as a
`COLLISION [rule n] … × …` line and the process exits 1 **before** any file is written.

Proof it bites, both observed during this build:

1. During development the pass rejected four real placements it found on its own —
   `[rule 6] edge E1 … × text "E1:label"`, `[rule 6] edge E10 …`, `[rule 6] edge E11 …`,
   `[rule 6b] arrowhead E10 × E10:label`, plus `[rule 13] edge E1 … leaves every reserved routing
   channel`. Each was fixed in the **layout model** (label offset now clears the stroke halo *and*
   the arrowhead half-span; the entry channel was widened to own the frame/group padding it
   traverses). No SVG was hand-edited at any point.
2. `scripts/gen-diagram.test.js` nudges one card by half a column width and asserts the pass reports
   a rule 4/5 failure — it does.

## The 8 known defects (D1–D8), checked by eye on the regenerated PNG

| # | Status | What the PNG shows |
|---|---|---|
| D1 | fixed | Guardrails (5) → Alert Writer (6) is one short straight vertical inside the column-5 corridor. It touches no text and crosses exactly two panel borders, each through a port notch. |
| D2 | fixed | `Structured JSON finding → Alert Writer (step 6)` sits in open whitespace in the row gutter, on an opaque background rect, 19 px clear of its own stroke and well inside the gutter band. |
| D3 | fixed | The Users dashed edge (E11) runs in the trunk channel below every panel and the AWS frame. It never enters a card. |
| D4 | fixed | `Engineers view alerts & insights · ask the AI chatbot (human-in-the-loop)` sits in the trunk channel, outside all panels, clear of the governance strip. |
| D5 | fixed | Each panel has a reserved title band (rule 8 forbids any segment or arrowhead entering it). The `Alert Storage & Custom Visualization` title is untouched. |
| D6 | fixed | `App logs / metrics` sits in the entry gutter, fully left of the AWS frame edge; the frame's dashed border has a clean port notch where the arrow crosses. |
| D7 | fixed | `Custom Web Dashboard → AI Log Chatbot` crosses the zone-C and zone-D borders perpendicular, inside the gutter, through port notches. |
| D8 | fixed | `Dashboard queries DynamoDB alerts + LIVE logs API` wraps to 3 lines inside the column gutter on an opaque rect, 15 px above its stroke and clear of the arrowhead. |

Additional scan for new overlaps: no arrow touches any glyph; no caption sits on a panel border; no
label is clipped by the frame or the canvas edge; badges 1–9 read as a left-to-right then
right-to-left snake; all card text is legible at 100 % zoom.

## Content diff vs the backed-up original

Extracted every `<text>` run from `OUTPUT/_originals_backup/Urbani_AWS_Architecture_Diagram.svg`
(105 runs) and from the new SVG (112 runs).

- **Nothing lost.** All 105 original runs are present. Four of them are now split across two
  rendered lines because they are wrapped to the card/label width instead of overflowing it:
  `• Suggests root cause + recommendations`, `temp 0.0 · max_tokens 1024 · Nova fallback`,
  `Structured JSON finding → Alert Writer (step 6)`, `Dashboard queries DynamoDB alerts + LIVE logs API`.
  The wording is unchanged.
- **Intentional additions (2 runs):** the legend rows `solid arrow = automated data flow` and
  `dashed arrow = human interaction / query`, per plan section 1.8. Removing the `LEGEND` array
  drops them and the layout reclaims the space.
- **No wording changes, no renames, no dropped node / bullet / badge / edge / edge label.**
- Styling-only change worth noting: the original shrank individual monospace detail lines to
  8.5–10.5 px to make them fit. They are now all 12 px, because the boxes are sized to the text
  instead of the text being squeezed into the boxes.

## Scope note

`scripts/gen-proposal.js` and `scripts/gen-deck.js` still embed the PNG at their existing hardcoded
dimensions (aspect 1.72 and 2.08 respectively, vs the new 1.90), so the figure is slightly stretched
inside the .docx and .pptx. That is plan item 9, outside this task's stated scope (generator + npm
script + regenerated assets), so neither consumer was touched and neither OUTPUT document was
regenerated.
