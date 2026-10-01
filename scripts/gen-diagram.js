/* Generates OUTPUT/Urbani_AWS_Architecture_Diagram.svg and .png — grid-laid-out,
   orthogonally routed, collision-asserted architecture diagram. Nothing overlaps:
   the run aborts with a non-zero exit code if any text, label, card or edge segment
   collides, so no overlapping output can ever be written. */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'OUTPUT');

// --- Palette ---
const INK = '#16191f';
const INK_SOFT = '#6b7480';
const PAGE = '#ffffff';
const CARD_FILL = '#ffffff';
const CARD_STROKE = '#dfe5ee';
const PANEL_FILL = '#f7f9fc';
const PANEL_STROKE = '#c7d0e0';
const PANEL_TITLE = '#232f3e';
const FRAME_FILL = '#fcfdff';
const FRAME_STROKE = '#232f3e';
const FLOW_SOLID = '#2f3742';
const FLOW_DASH = '#8a94a6';
const BADGE_FILL = '#232f3e';

// --- Layout constants (every coordinate in this file is derived from these) ---
const LAYOUT = {
  MARGIN: 44,
  HEADER_H: 120,
  SIDE_COL_W: 330,
  ENTRY_GUTTER: 190,
  COL_W_MIN: 262,
  GUTTER_X: 172,
  GROUP_PAD: 22,
  FRAME_PAD: 26,
  TITLE_BAND_H: 58,
  FRAME_TITLE_H: 66,
  ROW_GUTTER_Y: 126,
  TRUNK_H: 112,
  GOV_GAP: 0,
  CARD_PAD: 16,
  ICON: 64,
  ICON_GAP: 14,
  SIDE_ITEM_H: 60,
  SIDE_ICON: 50,
  AVATAR: 48,
  GOV_ICON: 42,
  CLEARANCE: 7,
  PORT_GAP: 5,
  LABEL_PAD: 6,
  BADGE_R: 13,
  ARROW_SOLID: 24,
  ARROW_DASH: 18,
  RASTER_W: 5400,
};

// --- Type scale (mirrors the <style> classes emitted into the SVG) ---
const TYPE = {
  h1: { size: 26, weight: 800, lh: 34, fill: INK },
  h2: { size: 14, weight: 400, lh: 20, fill: INK_SOFT },
  frameTitle: { size: 18, weight: 800, lh: 24, fill: PANEL_TITLE },
  ptitle: { cls: 'ptitle', size: 16, weight: 700, lh: 22 },
  psub: { cls: 'psub', size: 12, weight: 400, lh: 16 },
  ztitle: { cls: 'ztitle', size: 17, weight: 700, lh: 23 },
  zsub: { cls: 'zsub', size: 12, weight: 400, lh: 16 },
  nname: { cls: 'nname', size: 15, weight: 700, lh: 20 },
  nsub: { cls: 'nsub', size: 12, weight: 400, lh: 16 },
  nsubm: { cls: 'nsub mono', size: 12, weight: 400, lh: 16, mono: true },
  blt: { cls: 'blt', size: 12, weight: 400, lh: 16 },
  bltm: { cls: 'blt mono', size: 12, weight: 400, lh: 16, mono: true },
  bltb: { cls: 'blt', size: 12, weight: 700, lh: 16 },
  flow: { cls: 'flow', size: 12, weight: 400, lh: 16 },
};

// =====================================================================
// CONTENT MODEL — pure data, lifted verbatim from the original diagram
// =====================================================================

const TITLE_TEXT = 'URBANI — Proactive Observability & AI Troubleshooting Assistant';
const SUBTITLE_TEXT =
  'Target AWS Architecture · Custom Web Dashboard + AI Log Chatbot · Read-only · Evidence-based · Human-in-the-loop · 5-minute loop';
const FRAME_TITLE_TEXT = 'AWS Cloud (Urbani Account · ap-south-1)';

// Group panels. `cols` is an inclusive column span, `row` is the node row index.
const GROUPS = [
  {
    id: 'zone-a', row: 0, cols: [1, 3],
    title: 'Monitoring & Log Collection', sub: '(every 5 minutes)',
    fill: '#fdeff3', stroke: '#f3bdcc', color: '#be0f5e',
  },
  {
    id: 'zone-b', row: 0, cols: [4, 5],
    title: 'AI Analysis & Alert Processing', sub: '',
    fill: '#e7f6f1', stroke: '#a3dcc7', color: '#00857a',
  },
  {
    id: 'zone-d', row: 1, cols: [1, 2],
    title: 'AI Log Chatbot & Live Feed', sub: '',
    fill: '#fff6e5', stroke: '#e7cf92', color: '#9c6f08',
  },
  {
    id: 'zone-c', row: 1, cols: [3, 5],
    title: 'Alert Storage & Custom Visualization', sub: '',
    fill: '#eef7ea', stroke: '#bee0ab', color: '#4a8a2c',
  },
];

// Node cards. Row 0 reads left to right (1..5); row 1 reads right to left (6..9, API Gateway),
// so the 1..9 step order snakes through the grid and every edge stays straight.
const NODES = [
  {
    id: 'n1', group: 'zone-a', col: 1, badge: '1', icon: 'i-cw',
    title: 'Amazon CloudWatch', sub: 'Logs & Metrics',
    details: [
      { t: '• Application / system logs' },
      { t: '• Metrics · 30-day retention' },
      { t: '/aws/elasticbeanstalk/urbani-app', mono: true },
    ],
  },
  {
    id: 'n2', group: 'zone-a', col: 2, badge: '2', icon: 'i-eb',
    title: 'EventBridge', sub: 'Scheduler · rate(5m)',
    details: [
      { t: '• Fires every 5 minutes' },
      { t: '• 288 runs / day' },
      { t: '• Bounds token cost' },
    ],
  },
  {
    id: 'n3', group: 'zone-a', col: 3, badge: '3', icon: 'i-lambda',
    title: 'Lambda Collector', sub: 'UrbaniTelemetryCollectorFn', subMono: true,
    details: [
      { t: '• CloudWatch Insights query' },
      { t: '• Filters errors / exceptions' },
      { t: '• Max 100 log lines' },
    ],
  },
  {
    id: 'n4', group: 'zone-b', col: 4, badge: '4', icon: 'i-bedrock',
    title: 'Amazon Bedrock', sub: 'Claude 3.5 Sonnet v2 · LLM analysis',
    details: [
      { t: '• Analyzes log patterns · cites evidence' },
      { t: '• Suggests root cause + recommendations' },
      { t: 'temp 0.0 · max_tokens 1024 · Nova fallback', mono: true },
    ],
  },
  {
    id: 'n5', group: 'zone-b', col: 5, badge: '5', icon: 'i-guard',
    title: 'Bedrock Guardrails', sub: 'Safety & compliance',
    details: [
      { t: '• PII redaction · injection defense' },
      { t: 'urbani-dpi-guardrail-v1', mono: true },
      { t: 'NO_ANOMALY_DETECTED if none', mono: true },
    ],
  },
  {
    id: 'n6', group: 'zone-c', col: 5, badge: '6', icon: 'i-lambda',
    title: 'Lambda Alert Writer', sub: 'UrbaniAlertWriterFn', subMono: true,
    details: [
      { t: '• Validates strict JSON' },
      { t: '• Formats UrbaniIncidentAlert' },
      { t: '• Writes to DynamoDB' },
    ],
  },
  {
    id: 'n7', group: 'zone-c', col: 4, badge: '7', icon: 'i-ddb',
    title: 'Amazon DynamoDB', sub: 'UrbaniAlerts · KMS encrypted',
    details: [
      { t: 'PK service_id · SK timestamp', mono: true },
      { t: 'GSI anomaly_type-index', mono: true },
      { t: '• Alert history & pattern memory' },
    ],
  },
  {
    id: 'n8', group: 'zone-c', col: 3, badge: '8', icon: 'i-dash',
    title: 'Custom Web Dashboard', sub: 'React SPA + Node API · nginx',
    details: [
      { t: '• KPIs · alerts · logs · metrics' },
      { t: '• Reads DynamoDB + LIVE logs' },
      { t: '• NOT Grafana / CloudWatch dash' },
    ],
  },
  {
    id: 'n9', group: 'zone-d', col: 2, badge: '9', icon: 'i-chat',
    title: 'AI Log Chatbot', sub: '"Ask about the logs"',
    details: [
      { t: '• Natural-language Q&A over logs' },
      { t: '• Evidence-grounded · cites lines' },
      { t: '• Advisory only' },
    ],
  },
  {
    id: 'n-apigw', group: 'zone-d', col: 1, badge: '', icon: 'i-apigw',
    title: 'API Gateway', sub: 'LIVE logs · x-api-key',
    details: [
      { t: '• Real Urbani logs (5-min)' },
      { t: '• Read-only, secured' },
      { t: '/logs/latest', mono: true },
    ],
  },
];

const PANEL_APP = {
  id: 'panel-app', row: 0,
  title: 'Application / Services', sub: '(Existing — Urbani)',
  items: [
    { icon: 'i-ebapp', name: 'Elastic Beanstalk', sub: 'urbani-app (primary)' },
    { icon: 'i-ec2', name: 'EC2 / ECS / EKS', sub: 'apps & containers' },
    { icon: 'i-lam2', name: 'Lambda apps', sub: 'serverless services' },
    { icon: 'i-rds', name: 'RDS / data stores', sub: 'databases' },
    { icon: 'i-cloud', name: 'Other AWS services', sub: 'future scope' },
  ],
};

const PANEL_USERS = {
  id: 'panel-users', row: 1,
  title: 'Users / Team', sub: '',
  avatars: ['Operations', 'Development', 'Support'],
  caption: ['Step 10 · Engineers review evidence,', 'chat with the assistant, apply fix (manual)'],
};

const GOV_TITLE = 'Cross-cutting Governance & Key Configuration';

const GOV_TILES = [
  { icon: 'g-iam', name: 'IAM — least privilege', sub: 'read-only exec role' },
  { icon: 'g-kms', name: 'KMS — encryption', sub: 'at rest everywhere' },
  { icon: 'g-trail', name: 'CloudTrail — audit', sub: 'all API calls' },
  { icon: 'g-budget', name: 'AWS Budgets', sub: '$50 / $100 alerts' },
  { icon: 'g-guard', name: 'Guardrails', sub: 'PII + injection defense' },
  { icon: 'g-cdk', name: 'AWS CDK IaC', sub: 'all resources' },
];

const FOOTNOTES = [
  '• Visualization is a CUSTOM WEB DASHBOARD + AI Log Chatbot (React SPA + Node API behind nginx) — NOT Amazon Managed Grafana or CloudWatch dashboards.',
  '• Live logs integrated via API Gateway (/logs/latest, x-api-key). Metrics / services / alerts remain MOCK until endpoints are provisioned. MVP is READ-ONLY, human-in-the-loop.',
];

const LEGEND = [
  { style: 'solid', text: 'solid arrow = automated data flow' },
  { style: 'dashed', text: 'dashed arrow = human interaction / query' },
];

// Edges. `shape` names the routing template; geometry comes from the grid, never from literals.
const EDGES = [
  {
    id: 'E1', shape: 'h-row', from: { id: 'panel-app', port: 'right' }, to: { id: 'n1', port: 'left' },
    style: 'solid', label: ['App logs', '/ metrics'], labelAt: 'entry-above', labelBg: PAGE,
  },
  { id: 'E2', shape: 'h-row', from: { id: 'n1', port: 'right' }, to: { id: 'n2', port: 'left' }, style: 'solid' },
  { id: 'E3', shape: 'h-row', from: { id: 'n2', port: 'right' }, to: { id: 'n3', port: 'left' }, style: 'solid' },
  { id: 'E4', shape: 'h-row', from: { id: 'n3', port: 'right' }, to: { id: 'n4', port: 'left' }, style: 'solid' },
  { id: 'E5', shape: 'h-row', from: { id: 'n4', port: 'right' }, to: { id: 'n5', port: 'left' }, style: 'solid' },
  {
    id: 'E6', shape: 'v-col', from: { id: 'n5', port: 'bottom' }, to: { id: 'n6', port: 'top' },
    style: 'solid', label: ['Structured JSON finding → Alert Writer (step 6)'],
    labelAt: 'rowgutter-left', labelBg: FRAME_FILL, labelWrap: 210,
  },
  { id: 'E7', shape: 'h-row', from: { id: 'n6', port: 'left' }, to: { id: 'n7', port: 'right' }, style: 'solid' },
  { id: 'E8', shape: 'h-row', from: { id: 'n8', port: 'left' }, to: { id: 'n9', port: 'right' }, style: 'solid' },
  { id: 'E9', shape: 'h-row', from: { id: 'n-apigw', port: 'right' }, to: { id: 'n9', port: 'left' }, style: 'dashed' },
  {
    id: 'E10', shape: 'h-row', from: { id: 'n7', port: 'left' }, to: { id: 'n8', port: 'right' },
    style: 'dashed', label: ['Dashboard queries DynamoDB alerts + LIVE logs API'],
    labelAt: 'gutter-above', labelBg: '#eef7ea',
  },
  {
    id: 'E11', shape: 'trunk', from: { id: 'n8', port: 'bottom' }, to: { id: 'panel-users', port: 'bottom' },
    style: 'dashed', label: ['Engineers view alerts & insights · ask the AI chatbot (human-in-the-loop)'],
    labelAt: 'trunk-below', labelBg: PAGE, labelWrap: 760,
  },
];

// =====================================================================
// TEXT METRICS — per-character advance estimates, deliberately generous
// =====================================================================

const MONO_RATIO = 0.55;
const SAFETY = 1.06;

function charRatio(ch) {
  if (ch === ' ') return 0.27;
  if (ch === '·') return 0.33;
  if (ch === '—' || ch === '→') return 1.0;
  if ('iljt.,:;\'!|'.indexOf(ch) >= 0) return 0.30;
  if ('()[]{}/\\-'.indexOf(ch) >= 0) return 0.36;
  if ('frI'.indexOf(ch) >= 0) return 0.38;
  if ('MW'.indexOf(ch) >= 0) return 0.86;
  if ('mw'.indexOf(ch) >= 0) return 0.80;
  if (ch >= '0' && ch <= '9') return 0.56;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.53;
}

function textWidth(s, style) {
  const size = style.size;
  let em = 0;
  for (const ch of String(s)) em += style.mono ? MONO_RATIO : charRatio(ch);
  let w = em * size * SAFETY;
  if (!style.mono && style.weight >= 700) w *= 1.04;
  return w;
}

function wrapText(s, maxW, style) {
  const words = String(s).split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? cur + ' ' + word : word;
    if (cur && textWidth(next, style) > maxW) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function longestWord(s, style) {
  return String(s).split(' ').reduce((m, w) => Math.max(m, textWidth(w, style)), 0);
}

function ascent(style) {
  return Math.round(style.size * 0.78);
}

// =====================================================================
// GEOMETRY + COLLISION PRIMITIVES
// =====================================================================

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inflate(r, d) {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function segBox(s) {
  return {
    x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2),
    w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1),
  };
}

function segmentIntersectsRect(s, r) {
  return rectsIntersect(inflate(segBox(s), 0.5), r);
}

function segmentsCross(a, b) {
  const aH = a.y1 === a.y2;
  const bH = b.y1 === b.y2;
  if (aH === bH) return rectsIntersect(inflate(segBox(a), 0.5), inflate(segBox(b), 0.5));
  const h = aH ? a : b;
  const v = aH ? b : a;
  const hx1 = Math.min(h.x1, h.x2);
  const hx2 = Math.max(h.x1, h.x2);
  const vy1 = Math.min(v.y1, v.y2);
  const vy2 = Math.max(v.y1, v.y2);
  return v.x1 > hx1 && v.x1 < hx2 && h.y1 > vy1 && h.y1 < vy2;
}

function rectOfTextLine(x, top, text, style, anchor) {
  const w = textWidth(text, style);
  const left = anchor === 'middle' ? x - w / 2 : x;
  return { x: left, y: top, w: w, h: style.lh };
}

// =====================================================================
// LAYOUT ENGINE
// =====================================================================

function buildLayout() {
  const L = LAYOUT;
  const m = {
    rects: [], segments: [], arrows: [], notches: [],
    panels: [], cards: [], icons: [], badges: [], texts: [], labels: [],
    edges: [], decor: [],
  };

  const addRect = (r) => { m.rects.push(r); return r; };

  // --- card content measurement (uniform column width, uniform row height) ---
  const innerWMin = L.COL_W_MIN - 2 * L.CARD_PAD;
  let needInner = innerWMin;
  NODES.forEach((n) => {
    const subStyle = n.subMono ? TYPE.nsubm : TYPE.nsub;
    needInner = Math.max(needInner, longestWord(n.sub, subStyle));
    needInner = Math.max(needInner, longestWord(n.title, TYPE.nname));
    n.details.forEach((d) => {
      needInner = Math.max(needInner, longestWord(d.t, d.mono ? TYPE.bltm : TYPE.blt));
    });
  });
  const COL_W = Math.max(L.COL_W_MIN, Math.ceil(needInner) + 2 * L.CARD_PAD);
  const innerW = COL_W - 2 * L.CARD_PAD;

  // wrapped line plan for every card, and the uniform row height that fits them all
  const cardLines = {};
  let contentH = 0;
  NODES.forEach((n) => {
    const lines = [];
    lines.push({ style: TYPE.nname, text: n.title });
    const subStyle = n.subMono ? TYPE.nsubm : TYPE.nsub;
    wrapText(n.sub, innerW, subStyle).forEach((t) => lines.push({ style: subStyle, text: t }));
    lines.push({ gap: 8 });
    n.details.forEach((d) => {
      const st = d.mono ? TYPE.bltm : TYPE.blt;
      wrapText(d.t, innerW, st).forEach((t) => lines.push({ style: st, text: t }));
    });
    cardLines[n.id] = lines;
    const h = lines.reduce((a, l) => a + (l.gap || l.style.lh), 0);
    contentH = Math.max(contentH, h);
  });
  const CARD_H = L.CARD_PAD + L.ICON + L.ICON_GAP + contentH + L.CARD_PAD;

  // --- columns ---
  const frameX = L.MARGIN + L.SIDE_COL_W + L.ENTRY_GUTTER;
  const col1X = frameX + L.FRAME_PAD + L.GROUP_PAD;
  const colX = (i) => col1X + (i - 1) * (COL_W + L.GUTTER_X);
  const colCenter = (i) => colX(i) + COL_W / 2;

  // --- rows ---
  const headerBottom = L.MARGIN + L.HEADER_H;
  const frameY = headerBottom;
  const rowPanelY = [frameY + L.FRAME_TITLE_H, 0];
  const cardsY = [rowPanelY[0] + L.TITLE_BAND_H, 0];
  const rowPanelH = L.TITLE_BAND_H + CARD_H + L.GROUP_PAD;

  // side panel heights
  const appH = L.TITLE_BAND_H + PANEL_APP.items.length * L.SIDE_ITEM_H + L.GROUP_PAD;
  const usersAvatarBlock = L.AVATAR + 6 + TYPE.nsub.lh;
  const usersH = L.TITLE_BAND_H + usersAvatarBlock + 14 + PANEL_USERS.caption.length * TYPE.nsub.lh + L.GROUP_PAD;

  const row0Bottom = Math.max(rowPanelY[0] + rowPanelH, rowPanelY[0] + appH);
  rowPanelY[1] = row0Bottom + L.ROW_GUTTER_Y;
  cardsY[1] = rowPanelY[1] + L.TITLE_BAND_H;
  const row1ZoneBottom = rowPanelY[1] + rowPanelH;
  const frameBottom = row1ZoneBottom + L.FRAME_PAD;
  const bodyBottom = Math.max(frameBottom, rowPanelY[1] + usersH);
  const trunkY = bodyBottom + L.TRUNK_H / 2;

  const frameW = colX(5) + COL_W + L.GROUP_PAD + L.FRAME_PAD - frameX;
  const canvasW = frameX + frameW + L.MARGIN;

  // =============== page background + header ===============
  m.decor.push({ kind: 'bg', x: 0, y: 0, w: canvasW, h: 0 }); // h patched once canvasH known

  const titleStyle = TYPE.h1;
  const titleTop = L.MARGIN + 6;
  m.texts.push({ x: L.MARGIN, top: titleTop, text: TITLE_TEXT, style: titleStyle });
  addRect(Object.assign({ id: 'doc-title', kind: 'text', owner: 'canvas' },
    rectOfTextLine(L.MARGIN, titleTop, TITLE_TEXT, titleStyle)));

  const subTop = titleTop + titleStyle.lh + 6;
  m.texts.push({ x: L.MARGIN, top: subTop, text: SUBTITLE_TEXT, style: TYPE.h2 });
  addRect(Object.assign({ id: 'doc-sub', kind: 'text', owner: 'canvas' },
    rectOfTextLine(L.MARGIN, subTop, SUBTITLE_TEXT, TYPE.h2)));

  // =============== AWS cloud frame ===============
  const frame = {
    id: 'frame-aws', kind: 'frame', container: true,
    x: frameX, y: frameY, w: frameW, h: frameBottom - frameY,
    rx: 16, fill: FRAME_FILL, stroke: FRAME_STROKE, dash: '8 6', sw: 1.8,
  };
  m.panels.push(frame);
  addRect({ id: frame.id, kind: 'panel', container: true, x: frame.x, y: frame.y, w: frame.w, h: frame.h });

  const logoW = 66;
  const logoH = 40;
  const logoX = frameX + 20;
  const logoY = frameY + 14;
  m.icons.push({ href: 'aws-logo', x: logoX, y: logoY, w: logoW, h: logoH });
  addRect({ id: 'aws-logo', kind: 'icon', owner: frame.id, x: logoX, y: logoY, w: logoW, h: logoH });
  const frameTitleTop = logoY + 6;
  m.texts.push({ x: logoX + logoW + 12, top: frameTitleTop, text: FRAME_TITLE_TEXT, style: TYPE.frameTitle });
  const frameTitleRect = rectOfTextLine(logoX + logoW + 12, frameTitleTop, FRAME_TITLE_TEXT, TYPE.frameTitle);
  addRect(Object.assign({ id: 'frame-title', kind: 'text', owner: frame.id }, frameTitleRect));
  addRect({
    id: 'frame-aws:titleband', kind: 'titleband', owner: frame.id,
    x: logoX - 6, y: frameY + 1, w: (frameTitleRect.x + frameTitleRect.w + 6) - (logoX - 6), h: L.FRAME_TITLE_H - 2,
  });

  // =============== group panels ===============
  const panelById = {};
  GROUPS.forEach((g) => {
    const x = colX(g.cols[0]) - L.GROUP_PAD;
    const right = colX(g.cols[1]) + COL_W + L.GROUP_PAD;
    const p = {
      id: g.id, kind: 'panel', x: x, y: rowPanelY[g.row], w: right - x, h: rowPanelH,
      rx: 14, fill: g.fill, stroke: g.stroke, sw: 1.6, parentFill: FRAME_FILL,
    };
    panelById[g.id] = p;
    m.panels.push(p);
    addRect({ id: g.id, kind: 'panel', x: p.x, y: p.y, w: p.w, h: p.h });

    const tTop = p.y + 12;
    m.texts.push({ x: p.x + L.GROUP_PAD, top: tTop, text: g.title, style: TYPE.ztitle, fill: g.color });
    const tRect = rectOfTextLine(p.x + L.GROUP_PAD, tTop, g.title, TYPE.ztitle);
    addRect(Object.assign({ id: g.id + ':title', kind: 'text', owner: g.id }, tRect));
    let bandW = tRect.w;
    if (g.sub) {
      const sTop = tTop + TYPE.ztitle.lh;
      m.texts.push({ x: p.x + L.GROUP_PAD, top: sTop, text: g.sub, style: TYPE.zsub, fill: g.color });
      const sRect = rectOfTextLine(p.x + L.GROUP_PAD, sTop, g.sub, TYPE.zsub);
      addRect(Object.assign({ id: g.id + ':sub', kind: 'text', owner: g.id }, sRect));
      bandW = Math.max(bandW, sRect.w);
    }
    addRect({
      id: g.id + ':titleband', kind: 'titleband', owner: g.id,
      x: p.x + L.GROUP_PAD - 8, y: p.y + 1, w: bandW + 16, h: L.TITLE_BAND_H - 2,
    });
  });

  // =============== side panels ===============
  function sidePanel(def, h) {
    const p = {
      id: def.id, kind: 'panel', x: L.MARGIN, y: rowPanelY[def.row], w: L.SIDE_COL_W, h: h,
      rx: 14, fill: PANEL_FILL, stroke: PANEL_STROKE, sw: 1.5, parentFill: PAGE,
    };
    panelById[def.id] = p;
    m.panels.push(p);
    addRect({ id: def.id, kind: 'panel', x: p.x, y: p.y, w: p.w, h: p.h });
    const tTop = p.y + 12;
    m.texts.push({ x: p.x + L.GROUP_PAD, top: tTop, text: def.title, style: TYPE.ptitle, fill: PANEL_TITLE });
    const tRect = rectOfTextLine(p.x + L.GROUP_PAD, tTop, def.title, TYPE.ptitle);
    addRect(Object.assign({ id: def.id + ':title', kind: 'text', owner: def.id }, tRect));
    let bandW = tRect.w;
    if (def.sub) {
      const sTop = tTop + TYPE.ptitle.lh;
      m.texts.push({ x: p.x + L.GROUP_PAD, top: sTop, text: def.sub, style: TYPE.psub });
      const sRect = rectOfTextLine(p.x + L.GROUP_PAD, sTop, def.sub, TYPE.psub);
      addRect(Object.assign({ id: def.id + ':sub', kind: 'text', owner: def.id }, sRect));
      bandW = Math.max(bandW, sRect.w);
    }
    addRect({
      id: def.id + ':titleband', kind: 'titleband', owner: def.id,
      x: p.x + L.GROUP_PAD - 8, y: p.y + 1, w: bandW + 16, h: L.TITLE_BAND_H - 2,
    });
    return p;
  }

  const pApp = sidePanel(PANEL_APP, appH);
  PANEL_APP.items.forEach((it, i) => {
    const iy = pApp.y + L.TITLE_BAND_H + i * L.SIDE_ITEM_H;
    const ix = pApp.x + L.GROUP_PAD;
    m.icons.push({ href: it.icon, x: ix, y: iy, w: L.SIDE_ICON, h: L.SIDE_ICON });
    addRect({ id: PANEL_APP.id + ':icon' + i, kind: 'icon', owner: pApp.id, x: ix, y: iy, w: L.SIDE_ICON, h: L.SIDE_ICON });
    const tx = ix + L.SIDE_ICON + 14;
    const nTop = iy + 4;
    m.texts.push({ x: tx, top: nTop, text: it.name, style: TYPE.nname });
    addRect(Object.assign({ id: PANEL_APP.id + ':name' + i, kind: 'text', owner: pApp.id },
      rectOfTextLine(tx, nTop, it.name, TYPE.nname)));
    const sTop = nTop + TYPE.nname.lh;
    m.texts.push({ x: tx, top: sTop, text: it.sub, style: TYPE.nsub });
    addRect(Object.assign({ id: PANEL_APP.id + ':sub' + i, kind: 'text', owner: pApp.id },
      rectOfTextLine(tx, sTop, it.sub, TYPE.nsub)));
  });

  const pUsers = sidePanel(PANEL_USERS, usersH);
  const avSpan = (pUsers.w - 2 * L.GROUP_PAD) / PANEL_USERS.avatars.length;
  PANEL_USERS.avatars.forEach((name, i) => {
    const cx = pUsers.x + L.GROUP_PAD + avSpan * (i + 0.5);
    const ay = pUsers.y + L.TITLE_BAND_H;
    m.icons.push({ href: 'i-user', x: cx - L.AVATAR / 2, y: ay, w: L.AVATAR, h: L.AVATAR });
    addRect({ id: PANEL_USERS.id + ':av' + i, kind: 'icon', owner: pUsers.id, x: cx - L.AVATAR / 2, y: ay, w: L.AVATAR, h: L.AVATAR });
    const lTop = ay + L.AVATAR + 6;
    m.texts.push({ x: cx, top: lTop, text: name, style: TYPE.nsub, anchor: 'middle' });
    addRect(Object.assign({ id: PANEL_USERS.id + ':avlabel' + i, kind: 'text', owner: pUsers.id },
      rectOfTextLine(cx, lTop, name, TYPE.nsub, 'middle')));
  });
  const capTop0 = pUsers.y + L.TITLE_BAND_H + usersAvatarBlock + 14;
  PANEL_USERS.caption.forEach((line, i) => {
    const top = capTop0 + i * TYPE.nsub.lh;
    m.texts.push({ x: pUsers.x + L.GROUP_PAD, top: top, text: line, style: TYPE.nsub });
    addRect(Object.assign({ id: PANEL_USERS.id + ':cap' + i, kind: 'text', owner: pUsers.id },
      rectOfTextLine(pUsers.x + L.GROUP_PAD, top, line, TYPE.nsub)));
  });

  // =============== node cards ===============
  const cardById = {};
  NODES.forEach((n) => {
    const g = GROUPS.find((q) => q.id === n.group);
    const c = {
      id: n.id, kind: 'card', group: n.group,
      x: colX(n.col), y: cardsY[g.row], w: COL_W, h: CARD_H,
      rx: 12, fill: CARD_FILL, stroke: CARD_STROKE,
    };
    cardById[n.id] = c;
    m.cards.push(c);
    addRect({ id: n.id, kind: 'card', owner: n.id, group: n.group, x: c.x, y: c.y, w: c.w, h: c.h });

    const ix = c.x + L.CARD_PAD;
    const iy = c.y + L.CARD_PAD;
    m.icons.push({ href: n.icon, x: ix, y: iy, w: L.ICON, h: L.ICON });
    addRect({ id: n.id + ':icon', kind: 'icon', owner: n.id, x: ix, y: iy, w: L.ICON, h: L.ICON });

    if (n.badge) {
      const bx = ix + 6;
      const by = iy + 6;
      m.badges.push({ cx: bx, cy: by, r: L.BADGE_R, text: n.badge });
      addRect({
        id: n.id + ':badge', kind: 'badge', owner: n.id,
        x: bx - L.BADGE_R, y: by - L.BADGE_R, w: 2 * L.BADGE_R, h: 2 * L.BADGE_R,
      });
    }

    let top = c.y + L.CARD_PAD + L.ICON + L.ICON_GAP;
    cardLines[n.id].forEach((ln, i) => {
      if (ln.gap) { top += ln.gap; return; }
      m.texts.push({ x: ix, top: top, text: ln.text, style: ln.style });
      addRect(Object.assign({ id: n.id + ':l' + i, kind: 'text', owner: n.id },
        rectOfTextLine(ix, top, ln.text, ln.style)));
      top += ln.style.lh;
    });
  });

  // =============== governance strip ===============
  const govY = bodyBottom + L.TRUNK_H;
  const govX = L.MARGIN;
  const govW = canvasW - 2 * L.MARGIN;
  const govTitleTop = govY + 13;
  const tilesTop = govY + 46;
  const legendTop = tilesTop + L.GOV_ICON + 20;
  const footTop = legendTop + TYPE.blt.lh + 16;
  const govH = (footTop + FOOTNOTES.length * TYPE.blt.lh + 16) - govY;

  const gov = {
    id: 'strip-gov', kind: 'panel', x: govX, y: govY, w: govW, h: govH,
    rx: 14, fill: PANEL_FILL, stroke: PANEL_STROKE, sw: 1.5, parentFill: PAGE,
  };
  panelById[gov.id] = gov;
  m.panels.push(gov);
  addRect({ id: gov.id, kind: 'panel', x: gov.x, y: gov.y, w: gov.w, h: gov.h });

  m.texts.push({ x: govX + L.GROUP_PAD, top: govTitleTop, text: GOV_TITLE, style: TYPE.ptitle, fill: PANEL_TITLE });
  const govTitleRect = rectOfTextLine(govX + L.GROUP_PAD, govTitleTop, GOV_TITLE, TYPE.ptitle);
  addRect(Object.assign({ id: 'strip-gov:title', kind: 'text', owner: gov.id }, govTitleRect));
  addRect({
    id: 'strip-gov:titleband', kind: 'titleband', owner: gov.id,
    x: govX + L.GROUP_PAD - 8, y: govY + 1, w: govTitleRect.w + 16, h: 42,
  });

  const tileSpan = (govW - 2 * L.GROUP_PAD) / GOV_TILES.length;
  GOV_TILES.forEach((t, i) => {
    const tx = govX + L.GROUP_PAD + i * tileSpan;
    m.icons.push({ href: t.icon, x: tx, y: tilesTop, w: L.GOV_ICON, h: L.GOV_ICON });
    addRect({ id: 'gov:icon' + i, kind: 'icon', owner: gov.id, x: tx, y: tilesTop, w: L.GOV_ICON, h: L.GOV_ICON });
    const lx = tx + L.GOV_ICON + 10;
    m.texts.push({ x: lx, top: tilesTop + 2, text: t.name, style: TYPE.bltb });
    addRect(Object.assign({ id: 'gov:name' + i, kind: 'text', owner: gov.id },
      rectOfTextLine(lx, tilesTop + 2, t.name, TYPE.bltb)));
    m.texts.push({ x: lx, top: tilesTop + 2 + TYPE.bltb.lh, text: t.sub, style: TYPE.blt });
    addRect(Object.assign({ id: 'gov:sub' + i, kind: 'text', owner: gov.id },
      rectOfTextLine(lx, tilesTop + 2 + TYPE.bltb.lh, t.sub, TYPE.blt)));
  });

  // legend: sample stroke + caption, placed in the reserved footer band
  let lx = govX + L.GROUP_PAD;
  LEGEND.forEach((le, i) => {
    const sampleW = 44;
    const sy = legendTop + TYPE.blt.lh / 2;
    m.decor.push({ kind: 'legend-line', x1: lx, y1: sy, x2: lx + sampleW, y2: sy, style: le.style });
    addRect({ id: 'legend:line' + i, kind: 'text', owner: gov.id, x: lx, y: sy - 6, w: sampleW, h: 12 });
    const tx = lx + sampleW + 12;
    m.texts.push({ x: tx, top: legendTop, text: le.text, style: TYPE.blt });
    const r = rectOfTextLine(tx, legendTop, le.text, TYPE.blt);
    addRect(Object.assign({ id: 'legend:text' + i, kind: 'text', owner: gov.id }, r));
    lx = r.x + r.w + 48;
  });

  FOOTNOTES.forEach((f, i) => {
    const top = footTop + i * TYPE.blt.lh;
    m.texts.push({ x: govX + L.GROUP_PAD, top: top, text: f, style: TYPE.blt });
    addRect(Object.assign({ id: 'gov:foot' + i, kind: 'text', owner: gov.id },
      rectOfTextLine(govX + L.GROUP_PAD, top, f, TYPE.blt)));
  });

  const canvasH = govY + govH + L.MARGIN;
  m.decor[0].h = canvasH;

  // =============== routing channels ===============
  // Vertical channels: the entry gutter and each inter-column gutter.
  // Column corridors: the x-span of each column (and of the side column).
  // Horizontal channels: the row gutter and the trunk band.
  const channels = [];
  // the entry channel also owns the frame + group padding it has to traverse to reach col 1
  channels.push({ id: 'ch-entry', x: pApp.x + pApp.w, y: 0, w: col1X - (pApp.x + pApp.w), h: canvasH });
  for (let i = 1; i < 5; i += 1) {
    channels.push({ id: 'ch-gut' + i, x: colX(i) + COL_W, y: 0, w: L.GUTTER_X, h: canvasH });
  }
  channels.push({ id: 'ch-col0', x: L.MARGIN, y: 0, w: L.SIDE_COL_W, h: canvasH });
  for (let i = 1; i <= 5; i += 1) {
    channels.push({ id: 'ch-col' + i, x: colX(i), y: 0, w: COL_W, h: canvasH });
  }
  channels.push({ id: 'ch-row', x: 0, y: row0Bottom, w: canvasW, h: L.ROW_GUTTER_Y });
  channels.push({ id: 'ch-trunk', x: 0, y: bodyBottom, w: canvasW, h: L.TRUNK_H });

  // =============== edges ===============
  const G = L.PORT_GAP;
  const portOwnerGroup = (id) => (cardById[id] ? cardById[id].group : id);

  EDGES.forEach((e) => {
    const src = cardById[e.from.id] || panelById[e.from.id];
    const dst = cardById[e.to.id] || panelById[e.to.id];
    const segs = [];
    let arrow = null;

    if (e.shape === 'h-row') {
      const row = cardById[e.to.id]
        ? GROUPS.find((q) => q.id === cardById[e.to.id].group).row
        : GROUPS.find((q) => q.id === cardById[e.from.id].group).row;
      const y = cardsY[row] + CARD_H / 2;
      const x1 = e.from.port === 'right' ? src.x + src.w + G : src.x - G;
      const x2 = e.to.port === 'left' ? dst.x - G : dst.x + dst.w + G;
      segs.push({ x1: x1, y1: y, x2: x2, y2: y });
      arrow = { x: x2, y: y, dir: x2 > x1 ? 'r' : 'l' };
    } else if (e.shape === 'v-col') {
      const x = colCenter(NODES.find((n) => n.id === e.from.id).col);
      const y1 = src.y + src.h + G;
      const y2 = dst.y - G;
      segs.push({ x1: x, y1: y1, x2: x, y2: y2 });
      arrow = { x: x, y: y2, dir: 'd' };
    } else if (e.shape === 'trunk') {
      const x1 = colCenter(NODES.find((n) => n.id === e.from.id).col);
      const x2 = dst.x + dst.w / 2;
      segs.push({ x1: x1, y1: src.y + src.h + G, x2: x1, y2: trunkY });
      segs.push({ x1: x1, y1: trunkY, x2: x2, y2: trunkY });
      segs.push({ x1: x2, y1: trunkY, x2: x2, y2: dst.y + dst.h + G });
      arrow = { x: x2, y: dst.y + dst.h + G, dir: 'u' };
    }

    segs.forEach((s, i) => {
      if (s.x1 !== s.x2 && s.y1 !== s.y2) {
        throw new Error('non-orthogonal segment on ' + e.id + ' #' + i);
      }
      m.segments.push(Object.assign({ edgeId: e.id, fromId: e.from.id, toId: e.to.id }, s));
    });

    const aLen = e.style === 'solid' ? L.ARROW_SOLID : L.ARROW_DASH;
    const aW = aLen;
    let ar;
    if (arrow.dir === 'r') ar = { x: arrow.x - aLen, y: arrow.y - aW / 2, w: aLen + 3, h: aW };
    else if (arrow.dir === 'l') ar = { x: arrow.x - 3, y: arrow.y - aW / 2, w: aLen + 3, h: aW };
    else if (arrow.dir === 'd') ar = { x: arrow.x - aW / 2, y: arrow.y - aLen, w: aW, h: aLen + 3 };
    else ar = { x: arrow.x - aW / 2, y: arrow.y - 3, w: aW, h: aLen + 3 };
    m.arrows.push(Object.assign({ edgeId: e.id, toId: e.to.id, fromId: e.from.id }, ar));

    m.edges.push({ id: e.id, style: e.style, segs: segs });

    // --- port notches where a segment crosses a panel / frame border ---
    segs.forEach((s) => {
      m.panels.forEach((p) => {
        if (p.id === 'strip-gov') return;
        const pf = p.parentFill || PAGE;
        const sw = e.style === 'solid' ? 22 : 18;
        if (s.y1 === s.y2) {
          const y = s.y1;
          if (y <= p.y || y >= p.y + p.h) return;
          const xa = Math.min(s.x1, s.x2);
          const xb = Math.max(s.x1, s.x2);
          [[p.x, 1], [p.x + p.w, -1]].forEach((b) => {
            const bx = b[0];
            const insideDir = b[1];
            if (bx <= xa || bx >= xb) return;
            m.notches.push({ x: bx, y: y - sw / 2, w: 5, h: sw, fill: pf, side: 'out', vertical: true, insideDir: insideDir, panel: p.id });
            m.notches.push({ x: bx, y: y - sw / 2, w: 5, h: sw, fill: p.fill, side: 'in', vertical: true, insideDir: insideDir, panel: p.id });
          });
        } else {
          const x = s.x1;
          if (x <= p.x || x >= p.x + p.w) return;
          const ya = Math.min(s.y1, s.y2);
          const yb = Math.max(s.y1, s.y2);
          [[p.y, 1], [p.y + p.h, -1]].forEach((b) => {
            const by = b[0];
            const insideDir = b[1];
            if (by <= ya || by >= yb) return;
            m.notches.push({ x: x - sw / 2, y: by, w: sw, h: 5, fill: pf, side: 'out', vertical: false, insideDir: insideDir, panel: p.id });
            m.notches.push({ x: x - sw / 2, y: by, w: sw, h: 5, fill: p.fill, side: 'in', vertical: false, insideDir: insideDir, panel: p.id });
          });
        }
      });
    });

    // --- edge label in reserved channel whitespace ---
    if (!e.label) return;
    const st = TYPE.flow;
    let lines;
    if (e.label.length > 1) {
      lines = e.label.slice();
    } else {
      const wrapW = e.labelWrap || (L.GUTTER_X - 2 * L.LABEL_PAD - 8);
      lines = wrapText(e.label[0], wrapW, st);
    }
    const lw = lines.reduce((a, t) => Math.max(a, textWidth(t, st)), 0) + 2 * L.LABEL_PAD;
    const lh = lines.length * st.lh + 2 * L.LABEL_PAD;
    // clear the stroke, its CLEARANCE halo and the arrowhead's half-span in one go
    const off = Math.max(L.CLEARANCE + 4, aLen / 2 + 6);
    let box;
    if (e.labelAt === 'entry-above') {
      box = { x: pApp.x + pApp.w + 16, y: segs[0].y1 - off - lh, w: lw, h: lh };
    } else if (e.labelAt === 'gutter-above') {
      const cx = (segs[0].x1 + segs[0].x2) / 2;
      box = { x: cx - lw / 2, y: segs[0].y1 - off - lh, w: lw, h: lh };
    } else if (e.labelAt === 'rowgutter-left') {
      const vx = segs[0].x1;
      box = { x: vx - off - 8 - lw, y: row0Bottom + (L.ROW_GUTTER_Y - lh) / 2, w: lw, h: lh };
    } else {
      const h = segs[1];
      const cx = (h.x1 + h.x2) / 2;
      box = { x: cx - lw / 2, y: trunkY + off, w: lw, h: lh };
    }
    m.labels.push({ id: e.id + ':label', box: box, lines: lines, style: st, bg: e.labelBg });
    addRect({ id: e.id + ':label', kind: 'label', owner: e.id, x: box.x, y: box.y, w: box.w, h: box.h });
  });

  return {
    model: m,
    grid: {
      COL_W: COL_W, CARD_H: CARD_H, colX: colX, colCenter: colCenter,
      cardsY: cardsY, rowPanelY: rowPanelY, row0Bottom: row0Bottom,
      bodyBottom: bodyBottom, trunkY: trunkY, govY: govY,
    },
    channels: channels,
    panelById: panelById,
    cardById: cardById,
    portOwnerGroup: portOwnerGroup,
    canvas: { w: canvasW, h: canvasH },
  };
}

// =====================================================================
// COLLISION ASSERTION PASS — hard gate, runs before anything is written
// =====================================================================

function assertNoCollisions(layout) {
  const L = LAYOUT;
  const { model, canvas, channels, cardById } = layout;
  const fails = [];
  const fail = (rule, msg) => fails.push('COLLISION [rule ' + rule + '] ' + msg);

  const describe = (r) => r.id + ' @(' + [r.x, r.y, r.w, r.h].map((v) => Math.round(v)).join(',') + ')';
  const describeSeg = (s) => 'edge ' + s.edgeId + ' seg(' + Math.round(s.x1) + ',' + Math.round(s.y1) +
    ')-(' + Math.round(s.x2) + ',' + Math.round(s.y2) + ')';

  const rects = model.rects;
  const inked = rects.filter((r) => r.kind === 'text' || r.kind === 'label');
  const cards = rects.filter((r) => r.kind === 'card');
  const panels = rects.filter((r) => r.kind === 'panel' && !r.container);
  const bands = rects.filter((r) => r.kind === 'titleband');
  const badges = rects.filter((r) => r.kind === 'badge');
  let pairs = 0;

  // 1. no two text/label rects may intersect
  for (let i = 0; i < inked.length; i += 1) {
    for (let j = i + 1; j < inked.length; j += 1) {
      pairs += 1;
      if (rectsIntersect(inked[i], inked[j])) fail(1, describe(inked[i]) + ' × ' + describe(inked[j]));
    }
  }

  // 2. a badge may not cover any text/label
  badges.forEach((b) => {
    inked.forEach((t) => {
      pairs += 1;
      if (rectsIntersect(b, t)) fail(2, describe(b) + ' × ' + describe(t));
    });
  });

  // 3. text may not sit on a card it does not belong to
  inked.forEach((t) => {
    cards.forEach((c) => {
      pairs += 1;
      if (t.owner !== c.id && rectsIntersect(t, c)) fail(3, describe(t) + ' × card ' + describe(c));
    });
  });

  // 4. cards may not overlap
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      pairs += 1;
      if (rectsIntersect(cards[i], cards[j])) fail(4, describe(cards[i]) + ' × ' + describe(cards[j]));
    }
  }

  // 5. each card fully inside its own panel, and clear of every other panel
  cards.forEach((c) => {
    panels.forEach((p) => {
      pairs += 1;
      if (p.id === c.group) {
        if (!rectContains(p, c)) fail(5, 'card ' + describe(c) + ' not contained by panel ' + describe(p));
      } else if (rectsIntersect(c, p)) {
        fail(5, 'card ' + describe(c) + ' × foreign panel ' + describe(p));
      }
    });
  });

  // 6. no edge segment may touch any text/label (inflated by CLEARANCE)
  model.segments.forEach((s) => {
    inked.forEach((t) => {
      pairs += 1;
      if (segmentIntersectsRect(s, inflate(t, L.CLEARANCE))) {
        fail(6, describeSeg(s) + ' × text "' + (t.text || t.id) + '" ' + describe(t));
      }
    });
  });

  // 6b. no arrowhead may touch any text/label
  model.arrows.forEach((a) => {
    inked.forEach((t) => {
      pairs += 1;
      if (rectsIntersect(a, inflate(t, 2))) {
        fail('6b', 'arrowhead ' + a.edgeId + ' @(' + Math.round(a.x) + ',' + Math.round(a.y) + ') × ' + describe(t));
      }
    });
  });

  // 7. no edge segment may enter any card (ports sit PORT_GAP outside the card)
  model.segments.concat(model.arrows.map((a) => ({
    edgeId: a.edgeId, x1: a.x, y1: a.y, x2: a.x + a.w, y2: a.y + a.h, box: a,
  }))).forEach((s) => {
    cards.forEach((c) => {
      pairs += 1;
      const hit = s.box ? rectsIntersect(s.box, c) : segmentIntersectsRect(s, c);
      if (hit) fail(7, describeSeg(s) + ' × card ' + describe(c));
    });
  });

  // 8. no edge segment or arrowhead may enter a reserved title band
  model.segments.forEach((s) => {
    bands.forEach((b) => {
      pairs += 1;
      if (segmentIntersectsRect(s, b)) fail(8, describeSeg(s) + ' × title band ' + describe(b));
    });
  });
  model.arrows.forEach((a) => {
    bands.forEach((b) => {
      pairs += 1;
      if (rectsIntersect(a, b)) fail(8, 'arrowhead ' + a.edgeId + ' × title band ' + describe(b));
    });
  });

  // 9. segments from different edges may not cross
  for (let i = 0; i < model.segments.length; i += 1) {
    for (let j = i + 1; j < model.segments.length; j += 1) {
      const a = model.segments[i];
      const b = model.segments[j];
      if (a.edgeId === b.edgeId) continue;
      pairs += 1;
      if (segmentsCross(a, b)) fail(9, describeSeg(a) + ' × ' + describeSeg(b));
    }
  }

  // 10. no label may straddle a panel border
  const borders = [];
  panels.concat(rects.filter((r) => r.kind === 'panel' && r.container)).forEach((p) => {
    borders.push({ id: p.id + ':L', x: p.x - 1, y: p.y, w: 2, h: p.h });
    borders.push({ id: p.id + ':R', x: p.x + p.w - 1, y: p.y, w: 2, h: p.h });
    borders.push({ id: p.id + ':T', x: p.x, y: p.y - 1, w: p.w, h: 2 });
    borders.push({ id: p.id + ':B', x: p.x, y: p.y + p.h - 1, w: p.w, h: 2 });
  });
  rects.filter((r) => r.kind === 'label').forEach((lb) => {
    borders.forEach((b) => {
      pairs += 1;
      if (rectsIntersect(lb, inflate(b, L.CLEARANCE))) fail(10, 'label ' + describe(lb) + ' straddles ' + b.id);
    });
  });

  // 11. a segment may only enter a panel one of its endpoints belongs to
  model.segments.forEach((s) => {
    panels.forEach((p) => {
      pairs += 1;
      const fromGroup = cardById[s.fromId] ? cardById[s.fromId].group : s.fromId;
      const toGroup = cardById[s.toId] ? cardById[s.toId].group : s.toId;
      if (p.id === fromGroup || p.id === toGroup) return;
      if (segmentIntersectsRect(s, p)) fail(11, describeSeg(s) + ' × panel interior ' + describe(p));
    });
  });

  // 12. everything stays inside the canvas minus MARGIN
  const safe = { x: L.MARGIN, y: L.MARGIN, w: canvas.w - 2 * L.MARGIN, h: canvas.h - 2 * L.MARGIN };
  rects.forEach((r) => {
    pairs += 1;
    if (!rectContains(safe, r)) fail(12, describe(r) + ' outside the safe canvas area');
  });

  // 13. every segment lies inside a reserved channel or its own port corridor
  model.segments.forEach((s) => {
    pairs += 1;
    const box = inflate(segBox(s), 1);
    const ok = channels.some((c) => rectContains(inflate(c, 1), box));
    if (!ok) fail(13, describeSeg(s) + ' leaves every reserved routing channel');
  });

  const counts = {
    rects: rects.length, inked: inked.length, cards: cards.length,
    panels: panels.length, segments: model.segments.length,
    arrows: model.arrows.length, labels: model.labels.length, pairs: pairs,
  };
  return { fails: fails, counts: counts };
}

// =====================================================================
// SVG EMISSION
// =====================================================================

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DEFS = `  <defs>
    <style>
      .nname { font-size: 15px; font-weight: 700; fill: #16191f; }
      .nsub  { font-size: 12px; fill: #56606b; }
      .mono  { font-family: 'Consolas','Courier New',monospace; }
      .blt   { font-size: 12px; fill: #46505b; }
      .ztitle{ font-size: 17px; font-weight: 700; }
      .zsub  { font-size: 12px; }
      .ptitle{ font-size: 16px; font-weight: 700; fill: #232f3e; }
      .psub  { font-size: 12px; fill: #6b7480; }
      .flow  { font-size: 12px; fill: #5f6b7a; }
    </style>

    <linearGradient id="gCompute" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBA43A"/><stop offset="1" stop-color="#E1701A"/></linearGradient>
    <linearGradient id="gMgmt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F34E96"/><stop offset="1" stop-color="#BE0F5E"/></linearGradient>
    <linearGradient id="gML"  x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#40C4AA"/><stop offset="1" stop-color="#00857A"/></linearGradient>
    <linearGradient id="gSec" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F65B69"/><stop offset="1" stop-color="#BE1A31"/></linearGradient>
    <linearGradient id="gDb"  x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C24FE0"/><stop offset="1" stop-color="#8110B4"/></linearGradient>

    <marker id="ah" markerWidth="12" markerHeight="12" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#2f3742"/></marker>
    <marker id="ahg" markerWidth="12" markerHeight="12" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="#8a94a6"/></marker>

    <!-- ===== AWS smile logo ===== -->
    <symbol id="aws-logo" viewBox="0 0 100 60">
      <text x="50" y="30" font-size="30" font-weight="800" fill="#232f3e" text-anchor="middle" font-family="Arial">aws</text>
      <path d="M20 44c18 10 42 10 60 0" fill="none" stroke="#FF9900" stroke-width="5" stroke-linecap="round"/>
      <path d="M76 40l6 4-7 3z" fill="#FF9900"/>
    </symbol>

    <!-- ===== Service icons (64 tile) ===== -->
    <symbol id="i-cw" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gMgmt)"/>
      <path d="M23 40a8 8 0 0 1 .8-15.9A10 10 0 0 1 43 26a7 7 0 0 1-.6 14z" fill="#fff"/>
      <path d="M18 46h6l3.5-9 4.5 15 4.5-11 2.5 5h7" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>
    <symbol id="i-eb" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gMgmt)"/>
      <g stroke="#fff" stroke-width="2.6" fill="none"><path d="M26 23.5 30 41M40 23.5 36 41M26 21h14"/></g>
      <g fill="#fff"><circle cx="22" cy="21" r="6"/><circle cx="44" cy="21" r="6"/><circle cx="33" cy="44" r="6"/></g>
    </symbol>
    <symbol id="i-lambda" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gCompute)"/>
      <path d="M18 47 33 17h7L25 47z" fill="#fff"/>
      <path d="M35 28 46 47h-7l-7-13z" fill="#fff"/>
    </symbol>
    <symbol id="i-bedrock" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gML)"/>
      <g fill="none" stroke="#fff" stroke-width="2.8"><path d="M22 27v6c0 5 5 5 10 5s10 0 10-5v-6M27 22h10"/></g>
      <g fill="#fff"><circle cx="22" cy="22" r="5.5"/><circle cx="42" cy="22" r="5.5"/><circle cx="32" cy="43" r="5.5"/></g>
    </symbol>
    <symbol id="i-guard" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gSec)"/>
      <path d="M32 15l14 5.5v9.5c0 9.5-7 15-14 17.5-7-2.5-14-8-14-17.5V20.5z" fill="#fff"/>
      <path d="M25 31l5 5 9-11" fill="none" stroke="#BE1A31" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>
    <symbol id="i-ddb" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gDb)"/>
      <g fill="none" stroke="#fff" stroke-width="2.8"><ellipse cx="32" cy="20" rx="14" ry="5"/><path d="M18 20v24c0 2.8 6.3 5 14 5s14-2.2 14-5V20"/></g>
      <path d="M34 30l-6 9h5l-1 7 7-10h-5z" fill="#fff"/>
    </symbol>
    <symbol id="i-apigw" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gMgmt)"/>
      <g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M25 21 15 32l10 11M39 21l10 11-10 11M36 18 28 46"/></g>
    </symbol>
    <symbol id="i-dash" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gCompute)"/>
      <rect x="16" y="17" width="32" height="30" rx="3" fill="#fff"/>
      <path d="M16 24h32" stroke="#E1701A" stroke-width="2.4"/>
      <circle cx="21" cy="20.5" r="1.4" fill="#E1701A"/><circle cx="26" cy="20.5" r="1.4" fill="#E1701A"/>
      <path d="M22 42l6-8 4.5 4.5L40 28" fill="none" stroke="#E1701A" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>
    <symbol id="i-chat" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="url(#gML)"/>
      <path d="M17 22a4 4 0 0 1 4-4h22a4 4 0 0 1 4 4v13a4 4 0 0 1-4 4H28l-8 7v-7a4 4 0 0 1-3-4z" fill="#fff"/>
      <path d="M32 22.5l2 4.4 4.4 2-4.4 2-2 4.4-2-4.4-4.4-2 4.4-2z" fill="#00857A"/>
    </symbol>

    <!-- Existing-services panel icons -->
    <symbol id="i-ebapp" viewBox="0 0 56 56"><rect width="56" height="56" rx="11" fill="url(#gCompute)"/><g fill="none" stroke="#fff" stroke-width="2.6"><circle cx="28" cy="25" r="11"/><path d="M28 14v22M18 20l20 10M38 20 18 30"/></g><circle cx="28" cy="42" r="3.2" fill="#fff"/></symbol>
    <symbol id="i-ec2" viewBox="0 0 56 56"><rect width="56" height="56" rx="11" fill="url(#gCompute)"/><rect x="18" y="18" width="20" height="20" rx="2.5" fill="none" stroke="#fff" stroke-width="2.6"/><rect x="24" y="24" width="8" height="8" fill="#fff"/><path d="M23 13v5M28 13v5M33 13v5M23 38v5M28 38v5M33 38v5M13 23h5M13 28h5M13 33h5M38 23h5M38 28h5M38 33h5" stroke="#fff" stroke-width="2"/></symbol>
    <symbol id="i-lam2" viewBox="0 0 56 56"><rect width="56" height="56" rx="11" fill="url(#gCompute)"/><path d="M16 42 29 15h6L22 42z" fill="#fff"/><path d="M31 25 42 42h-6l-6.5-12z" fill="#fff"/></symbol>
    <symbol id="i-rds" viewBox="0 0 56 56"><rect width="56" height="56" rx="11" fill="url(#gDb)"/><g fill="none" stroke="#fff" stroke-width="2.6"><ellipse cx="28" cy="19" rx="12" ry="4.5"/><path d="M16 19v18c0 2.5 5.4 4.5 12 4.5s12-2 12-4.5V19"/></g></symbol>
    <symbol id="i-cloud" viewBox="0 0 56 56"><rect width="56" height="56" rx="11" fill="#8a94a6"/><path d="M20 36a7 7 0 0 1 .6-13.9A9 9 0 0 1 38 24a6 6 0 0 1-.5 12z" fill="#fff"/></symbol>
    <symbol id="i-user" viewBox="0 0 52 52"><circle cx="26" cy="26" r="24.5" fill="#eef1f6" stroke="#c3cddd" stroke-width="1.5"/><circle cx="26" cy="21" r="7.5" fill="none" stroke="#5f6b7a" stroke-width="2.6"/><path d="M13 40c0-7.5 6-11.5 13-11.5s13 4 13 11.5" fill="none" stroke="#5f6b7a" stroke-width="2.6"/></symbol>

    <!-- Governance mini tiles -->
    <symbol id="g-iam" viewBox="0 0 44 44"><rect width="44" height="44" rx="9" fill="url(#gSec)"/><circle cx="22" cy="18" r="5.5" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M12 33c0-5.5 4.5-9 10-9s10 3.5 10 9" fill="none" stroke="#fff" stroke-width="2.4"/></symbol>
    <symbol id="g-kms" viewBox="0 0 44 44"><rect width="44" height="44" rx="9" fill="url(#gSec)"/><circle cx="19" cy="19" r="5.5" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M22.5 22.5 33 33M28 33l3-3" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/></symbol>
    <symbol id="g-trail" viewBox="0 0 44 44"><rect width="44" height="44" rx="9" fill="url(#gMgmt)"/><path d="M13 31c0-5.5 4-9 9-9s9-3.5 9-9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="13" cy="31" r="2.6" fill="#fff"/><circle cx="31" cy="13" r="2.6" fill="#fff"/></symbol>
    <symbol id="g-budget" viewBox="0 0 44 44"><rect width="44" height="44" rx="9" fill="url(#gMgmt)"/><circle cx="22" cy="22" r="10" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M22 15v14M19 18.5c0-1.6 1.2-2.3 3-2.3s3 .8 3 2.2-1.2 1.9-3 2.4-3 .9-3 2.3 1.2 2.2 3 2.2 3-.7 3-2.2" fill="none" stroke="#fff" stroke-width="1.9"/></symbol>
    <symbol id="g-guard" viewBox="0 0 44 44"><rect width="44" height="44" rx="9" fill="url(#gSec)"/><path d="M22 11l9 3.5v6.5c0 6.5-4.5 10-9 12-4.5-2-9-5.5-9-12v-6.5z" fill="#fff"/><path d="M17.5 21.5l3.2 3.2L27 17" fill="none" stroke="#BE1A31" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="g-cdk" viewBox="0 0 44 44"><rect width="44" height="44" rx="9" fill="url(#gMgmt)"/><path d="M17 15l-7 7 7 7M27 15l7 7-7 7M25 13l-6 18" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  </defs>`;

function emitSvg(layout) {
  const { model, canvas } = layout;
  const n = (v) => Math.round(v * 10) / 10;
  const o = [];

  o.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + canvas.w + '" height="' + canvas.h +
    '" viewBox="0 0 ' + canvas.w + ' ' + canvas.h +
    '" font-family="\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif">');
  o.push(DEFS);
  o.push('  <rect width="' + canvas.w + '" height="' + canvas.h + '" fill="' + PAGE + '"/>');

  // --- panels (frame first so zone panels paint on top of it) ---
  o.push('  <!-- ===== Panels ===== -->');
  model.panels.forEach((p) => {
    o.push('  <rect x="' + n(p.x) + '" y="' + n(p.y) + '" width="' + n(p.w) + '" height="' + n(p.h) +
      '" rx="' + p.rx + '" fill="' + p.fill + '" stroke="' + p.stroke + '" stroke-width="' + p.sw +
      (p.dash ? '" stroke-dasharray="' + p.dash : '') + '"/>');
  });

  // --- node cards ---
  o.push('  <!-- ===== Node cards ===== -->');
  model.cards.forEach((c) => {
    o.push('  <rect x="' + n(c.x) + '" y="' + n(c.y) + '" width="' + n(c.w) + '" height="' + n(c.h) +
      '" rx="' + c.rx + '" fill="' + c.fill + '" stroke="' + c.stroke + '" stroke-width="1.2"/>');
  });

  // --- icons ---
  o.push('  <!-- ===== Icons ===== -->');
  model.icons.forEach((i) => {
    o.push('  <use href="#' + i.href + '" x="' + n(i.x) + '" y="' + n(i.y) + '" width="' + n(i.w) +
      '" height="' + n(i.h) + '"/>');
  });

  // --- badges ---
  o.push('  <!-- ===== Step badges ===== -->');
  model.badges.forEach((b) => {
    o.push('  <circle cx="' + n(b.cx) + '" cy="' + n(b.cy) + '" r="' + b.r + '" fill="' + BADGE_FILL + '"/>');
    o.push('  <text x="' + n(b.cx) + '" y="' + n(b.cy + 5) +
      '" font-size="13" font-weight="800" fill="#fff" text-anchor="middle">' + esc(b.text) + '</text>');
  });

  // --- text ---
  o.push('  <!-- ===== Text ===== -->');
  model.texts.forEach((t) => {
    const s = t.style;
    const attrs = [];
    if (s.cls) attrs.push('class="' + s.cls + '"');
    else attrs.push('font-size="' + s.size + '" font-weight="' + s.weight + '"');
    if (t.fill) attrs.push('fill="' + t.fill + '"');
    else if (!s.cls && s.fill) attrs.push('fill="' + s.fill + '"');
    if (s.cls && s.weight >= 700 && s.cls === 'blt') attrs.push('font-weight="700"');
    if (t.anchor) attrs.push('text-anchor="' + t.anchor + '"');
    o.push('  <text x="' + n(t.x) + '" y="' + n(t.top + ascent(s)) + '" ' + attrs.join(' ') + '>' +
      esc(t.text) + '</text>');
  });

  // --- port notches (painted over panel strokes before the arrows are drawn) ---
  o.push('  <!-- ===== Port notches ===== -->');
  model.notches.forEach((t) => {
    let x = t.x;
    let y = t.y;
    if (t.vertical) {
      x = t.side === 'in' ? (t.insideDir > 0 ? t.x : t.x - t.w) : (t.insideDir > 0 ? t.x - t.w : t.x);
    } else {
      y = t.side === 'in' ? (t.insideDir > 0 ? t.y : t.y - t.h) : (t.insideDir > 0 ? t.y - t.h : t.y);
    }
    o.push('  <rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(t.w) + '" height="' + n(t.h) +
      '" fill="' + t.fill + '"/>');
  });

  // --- edges ---
  o.push('  <!-- ===== Edges ===== -->');
  model.edges.forEach((e) => {
    const d = e.segs.map((s, i) => (i === 0 ? 'M' + n(s.x1) + ' ' + n(s.y1) : '') +
      (s.x1 === s.x2 ? 'V' + n(s.y2) : 'H' + n(s.x2))).join(' ');
    if (e.style === 'solid') {
      o.push('  <path d="' + d + '" fill="none" stroke="' + FLOW_SOLID +
        '" stroke-width="2.6" marker-end="url(#ah)"/>');
    } else {
      o.push('  <path d="' + d + '" fill="none" stroke="' + FLOW_DASH +
        '" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#ahg)"/>');
    }
  });

  // --- legend sample strokes ---
  model.decor.filter((d) => d.kind === 'legend-line').forEach((d) => {
    if (d.style === 'solid') {
      o.push('  <path d="M' + n(d.x1) + ' ' + n(d.y1) + 'H' + n(d.x2) + '" stroke="' + FLOW_SOLID +
        '" stroke-width="2.6"/>');
    } else {
      o.push('  <path d="M' + n(d.x1) + ' ' + n(d.y1) + 'H' + n(d.x2) + '" stroke="' + FLOW_DASH +
        '" stroke-width="2" stroke-dasharray="6 5"/>');
    }
  });

  // --- edge labels (opaque background rect so no stroke shows through the glyphs) ---
  o.push('  <!-- ===== Edge labels ===== -->');
  model.labels.forEach((lb) => {
    o.push('  <rect x="' + n(lb.box.x) + '" y="' + n(lb.box.y) + '" width="' + n(lb.box.w) +
      '" height="' + n(lb.box.h) + '" rx="4" fill="' + lb.bg + '" fill-opacity="1"/>');
    lb.lines.forEach((line, i) => {
      o.push('  <text x="' + n(lb.box.x + LAYOUT.LABEL_PAD) + '" y="' +
        n(lb.box.y + LAYOUT.LABEL_PAD + i * lb.style.lh + ascent(lb.style)) +
        '" class="' + lb.style.cls + '">' + esc(line) + '</text>');
    });
  });

  o.push('</svg>');
  o.push('');
  return o.join('\n');
}

function emitDebugOverlay(layout) {
  const { model, canvas, channels } = layout;
  const o = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + canvas.w + '" height="' + canvas.h +
    '" viewBox="0 0 ' + canvas.w + ' ' + canvas.h + '">'];
  o.push('<rect width="' + canvas.w + '" height="' + canvas.h + '" fill="#fff"/>');
  channels.forEach((c) => o.push('<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' +
    c.h + '" fill="none" stroke="#dddddd"/>'));
  model.rects.forEach((r) => o.push('<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' +
    r.h + '" fill="none" stroke="magenta" stroke-width="0.8"/>'));
  model.segments.forEach((s) => o.push('<path d="M' + s.x1 + ' ' + s.y1 + 'L' + s.x2 + ' ' + s.y2 +
    '" stroke="cyan" stroke-width="2"/>'));
  o.push('</svg>');
  return o.join('\n');
}

// =====================================================================
// MAIN
// =====================================================================

function main(argv) {
  const dryRun = argv.indexOf('--dry-run') >= 0;
  const debug = argv.indexOf('--debug') >= 0;

  const layout = buildLayout();
  const { fails, counts } = assertNoCollisions(layout);

  console.log('Inventory: nodes ' + NODES.length + ' · side items ' + PANEL_APP.items.length +
    ' · groups ' + (GROUPS.length + 4) + ' · edges ' + EDGES.length +
    ' · gov tiles ' + GOV_TILES.length + ' · footnotes ' + FOOTNOTES.length);
  console.log('Canvas: ' + layout.canvas.w + ' x ' + layout.canvas.h +
    ' (col width ' + layout.grid.COL_W + ', card height ' + layout.grid.CARD_H + ')');
  console.log('Checked: rects ' + counts.rects + ' (inked ' + counts.inked + ', cards ' + counts.cards +
    ', panels ' + counts.panels + ') · segments ' + counts.segments + ' · arrowheads ' + counts.arrows +
    ' · labels ' + counts.labels + ' · ' + counts.pairs + ' pair comparisons');

  if (debug) {
    const dbg = path.join(OUT, '_debug_diagram_overlay.svg');
    fs.writeFileSync(dbg, emitDebugOverlay(layout));
    console.log('Wrote ' + path.basename(dbg));
  }

  if (fails.length) {
    fails.forEach((f) => console.error(f));
    console.error(fails.length + ' collision(s) — refusing to write output.');
    process.exit(1);
  }
  console.log('0 collisions');

  if (dryRun) {
    console.log('--dry-run: no files written');
    return;
  }

  const svg = emitSvg(layout);
  const svgFile = path.join(OUT, 'Urbani_AWS_Architecture_Diagram.svg');
  fs.writeFileSync(svgFile, svg, 'utf8');
  console.log('Wrote ' + path.basename(svgFile));

  const density = Math.round((72 * LAYOUT.RASTER_W) / layout.canvas.w);
  const pngFile = path.join(OUT, 'Urbani_AWS_Architecture_Diagram.png');
  sharp(Buffer.from(svg), { density: density })
    .png()
    .toFile(pngFile)
    .then(() => console.log('Wrote ' + path.basename(pngFile)))
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = {
  LAYOUT, TYPE, GROUPS, NODES, EDGES, GOV_TILES, FOOTNOTES, LEGEND,
  PANEL_APP, PANEL_USERS,
  charRatio, textWidth, wrapText, rectOfTextLine,
  rectsIntersect, inflate, rectContains, segBox, segmentIntersectsRect, segmentsCross,
  buildLayout, assertNoCollisions, emitSvg,
};

if (require.main === module) main(process.argv.slice(2));
