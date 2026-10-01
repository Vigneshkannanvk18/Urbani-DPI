/* Unit tests for the geometry + collision primitives in scripts/gen-diagram.js.
   Run with: node --test scripts/gen-diagram.test.js */
const test = require('node:test');
const assert = require('node:assert');

const gd = require('./gen-diagram');

// --- rect primitives ---
test('rectsIntersect detects overlap and ignores edge contact', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.strictEqual(gd.rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.strictEqual(gd.rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.strictEqual(gd.rectsIntersect(a, { x: 20, y: 0, w: 10, h: 10 }), false);
});

test('inflate grows a rect on every side', () => {
  assert.deepStrictEqual(gd.inflate({ x: 10, y: 10, w: 10, h: 10 }, 5),
    { x: 5, y: 5, w: 20, h: 20 });
});

test('rectContains requires full containment', () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 };
  assert.strictEqual(gd.rectContains(outer, { x: 10, y: 10, w: 20, h: 20 }), true);
  assert.strictEqual(gd.rectContains(outer, { x: 90, y: 10, w: 20, h: 20 }), false);
});

// --- segment primitives ---
test('segmentIntersectsRect catches an arrow crossing a text box', () => {
  const text = { x: 100, y: 50, w: 200, h: 16 };
  assert.strictEqual(gd.segmentIntersectsRect({ x1: 0, y1: 58, x2: 400, y2: 58 }, text), true);
  assert.strictEqual(gd.segmentIntersectsRect({ x1: 0, y1: 200, x2: 400, y2: 200 }, text), false);
  // vertical line straight through the same box
  assert.strictEqual(gd.segmentIntersectsRect({ x1: 150, y1: 0, x2: 150, y2: 400 }, text), true);
});

test('segmentsCross flags a real crossing', () => {
  const h = { x1: 0, y1: 100, x2: 200, y2: 100 };
  const v = { x1: 100, y1: 0, x2: 100, y2: 200 };
  assert.strictEqual(gd.segmentsCross(h, v), true);
});

test('segmentsCross does not flag segments that only meet at a shared port', () => {
  // an L-bend: the vertical ends exactly where the horizontal begins
  const v = { x1: 100, y1: 0, x2: 100, y2: 100 };
  const h = { x1: 100, y1: 100, x2: 300, y2: 100 };
  assert.strictEqual(gd.segmentsCross(v, h), false);
});

test('segmentsCross flags overlapping parallel segments only', () => {
  const a = { x1: 0, y1: 100, x2: 200, y2: 100 };
  assert.strictEqual(gd.segmentsCross(a, { x1: 150, y1: 100, x2: 400, y2: 100 }), true);
  assert.strictEqual(gd.segmentsCross(a, { x1: 0, y1: 160, x2: 200, y2: 160 }), false);
});

// --- text metrics ---
test('textWidth grows with length and wrapText respects the limit', () => {
  const st = gd.TYPE.blt;
  assert.ok(gd.textWidth('aaaa', st) > gd.textWidth('aa', st));
  const lines = gd.wrapText('Dashboard queries DynamoDB alerts + LIVE logs API', 150, st);
  assert.ok(lines.length > 1);
  lines.forEach((l) => assert.ok(gd.textWidth(l, st) <= 150, 'line too wide: ' + l));
});

test('rectOfTextLine centres on the anchor when asked', () => {
  const st = gd.TYPE.blt;
  const left = gd.rectOfTextLine(100, 10, 'Development', st);
  const mid = gd.rectOfTextLine(100, 10, 'Development', st, 'middle');
  assert.strictEqual(left.w, mid.w);
  assert.ok(Math.abs((mid.x + mid.w / 2) - 100) < 0.001);
});

// --- the assertion pass itself ---
test('the real layout passes every collision rule', () => {
  const layout = gd.buildLayout();
  const res = gd.assertNoCollisions(layout);
  assert.deepStrictEqual(res.fails, [], res.fails.join('\n'));
  assert.strictEqual(res.counts.cards, gd.NODES.length);
  assert.ok(res.counts.pairs > 1000);
});

test('the assertion pass bites when a card is nudged out of place', () => {
  const layout = gd.buildLayout();
  const card = layout.model.cards[3];
  const rect = layout.model.rects.find((r) => r.kind === 'card' && r.id === card.id);
  const shift = layout.grid.COL_W / 2;
  card.x -= shift;
  rect.x -= shift;
  const res = gd.assertNoCollisions(layout);
  assert.ok(res.fails.length > 0, 'a half-column shift must be detected');
  assert.ok(res.fails.some((f) => f.indexOf('[rule 4]') >= 0 || f.indexOf('[rule 5]') >= 0),
    'expected a card overlap or containment failure, got:\n' + res.fails.join('\n'));
});
