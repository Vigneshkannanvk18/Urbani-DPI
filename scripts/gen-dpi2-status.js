/* =============================================================================
 * gen-dpi2-status.js -- Generates OUTPUT/Urbani_DPI2_Delivery_Status.pdf
 *
 * Client-facing DPI 2 ("Radar UrbiNexus") delivery status: what is built, what
 * is pending, and exactly what Urbani needs to provide. Built with pdfkit and the
 * same layout approach proven in scripts/gen-docs.js and gen-dpi2-docs.js:
 *   - flow()/need() measure BEFORE drawing, so no blank pages.
 *   - autoFirstPage:false and a tiny bottom margin (8 pt), so footers written
 *     near the page edge can never create phantom pages.
 *   - bufferPages + a two-pass TOC onto a reserved page 2; footers stamped last.
 *   - Helvetica only: no arrows, check marks or emoji (ASCII '->' and words).
 *
 * Honesty rule: nothing here claims a feature works against real AWS, Cognito,
 * Google, Slack, Teams or SNS. Everything was verified against local stand-ins.
 *
 * Run:  npm run gen:dpi2:status   (or: node scripts/gen-dpi2-status.js)
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// ---- Brand palette ----------------------------------------------------------
const GOLD = '#D1990A';
const GOLD_SOFT = '#FBF5E6';
const DARK = '#172033';
const GREY = '#667085';
const LIGHT = '#F3F4F6';
const BORDER = '#E4E7EC';
const DOT = '#C9CDD4';
const WHITE = '#FFFFFF';
const BLUE_SOFT = '#EAF1FB';
const BLUE = '#2E6FD6';
const GREEN = '#1B7F4B';
const GREEN_SOFT = '#E8F5EE';
const AMBER = '#B45F06';
const AMBER_SOFT = '#FDF0DC';
const RED = '#B42318';

const OUT_DIR = path.join(__dirname, '..', 'OUTPUT');
const OUT_FILE = path.join(OUT_DIR, 'Urbani_DPI2_Delivery_Status.pdf');
const DIAGRAM = path.join(OUT_DIR, 'Urbani_AWS_Architecture_Diagram_DPI2.png');
const DIAGRAM_PX = { w: 5401, h: 3286 }; // measured with sharp

// ---- Page geometry (A4 portrait, pt) ---------------------------------------
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 56;
const TOP = M;
const BOTTOM = PAGE_H - M;
const CONTENT_W = PAGE_W - M * 2;
const FOOT_Y = PAGE_H - M + 16;

const FOOTER_TITLE = 'Radar UrbiNexus -- DPI 2: Delivery Status & Client Requirements';

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: M, bottom: 8, left: M, right: M },
  bufferPages: true,
  autoFirstPage: false,
  info: {
    Title: 'Radar UrbiNexus - DPI 2: Delivery Status & Client Requirements',
    Author: 'Urbani Observability',
    Subject: 'What is delivered, what is pending, and what we need from Urbani',
  },
});
doc.pipe(fs.createWriteStream(OUT_FILE));

let y = TOP;
let pageNo = 0;
const toc = [];

// =============================================================================
// Core layout primitives (same proven approach as gen-docs.js)
// =============================================================================
function newPage() { doc.addPage(); pageNo += 1; y = TOP; }
function need(h) { if (y + h > BOTTOM) newPage(); }

function measure(text, { font = 'Helvetica', size = 10.5, width = CONTENT_W, lineGap = 2.5 } = {}) {
  doc.font(font).fontSize(size);
  return doc.heightOfString(text, { width, lineGap });
}

function flow(text, opts = {}) {
  const font = opts.bold ? 'Helvetica-Bold' : opts.oblique ? 'Helvetica-Oblique' : 'Helvetica';
  const size = opts.size || 10.5;
  const width = opts.width || CONTENT_W;
  const x = opts.x != null ? opts.x : M;
  const lineGap = opts.lineGap != null ? opts.lineGap : 2.5;
  const h = measure(text, { font, size, width, lineGap });
  if (y + h > BOTTOM) { if (h <= BOTTOM - TOP) newPage(); else need(0); }
  doc.font(font).fontSize(size).fillColor(opts.color || DARK)
    .text(text, x, y, { width, align: opts.align || 'left', lineGap });
  y = doc.y;
  y += opts.after != null ? opts.after : 6;
}

function gap(h) { y += h; if (y > BOTTOM) newPage(); }

function heading(number, title, level = 1) {
  const label = number ? `${number}  ${title}` : title;
  // Keep room for the heading plus the first lines of what follows (no orphan headings).
  need(level === 1 ? 90 : 70);
  if (level === 1 && y > TOP + 2) gap(8);
  toc.push({ title: label, level, page: pageNo });
  if (level === 1) {
    doc.font('Helvetica-Bold').fontSize(15).fillColor(DARK).text(label, M, y, { width: CONTENT_W });
    y = doc.y + 3;
    doc.moveTo(M, y).lineTo(PAGE_W - M, y).lineWidth(1.4).strokeColor(GOLD).stroke();
    y += 10;
  } else {
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor(GOLD).text(label, M, y, { width: CONTENT_W });
    y = doc.y + 5;
  }
  doc.fillColor(DARK);
}

function para(text, opts = {}) { flow(text, { ...opts, after: opts.after != null ? opts.after : 8 }); }

function bullets(items) {
  const size = 10.5;
  const textX = M + 16;
  const textW = CONTENT_W - 16;
  for (const it of items) {
    const isObj = typeof it !== 'string';
    const full = isObj ? `${it.label}: ${it.text}` : it;
    const h = measure(full, { size, width: textW });
    need(h + 4);
    const rowY = y;
    doc.font('Helvetica-Bold').fontSize(size).fillColor(GOLD).text('\u2022', M + 4, rowY, { lineBreak: false });
    doc.fillColor(DARK);
    if (isObj) {
      doc.font('Helvetica-Bold').fontSize(size)
        .text(`${it.label}: `, textX, rowY, { width: textW, continued: true })
        .font('Helvetica').text(it.text);
    } else {
      doc.font('Helvetica').fontSize(size).fillColor(DARK).text(it, textX, rowY, { width: textW, lineGap: 2 });
    }
    y = doc.y + 4;
  }
  y += 4;
}

function statusColor(line) {
  const l = line.toLowerCase();
  if (l.startsWith('built and tested') || l.startsWith('met') || l.startsWith('done')) return GREEN;
  if (l.startsWith('awaiting') || l.startsWith('partly') || l.startsWith('pending')) return AMBER;
  if (l.startsWith('decision')) return BLUE;
  return DARK;
}

/**
 * table(header, rows, fracs, opts)
 *   rows: array of string[] or { group: 'Heading' } (full-width band row)
 *   opts.size: font size (default 9.5)
 *   opts.statusCols: column indexes whose lines are coloured by status keyword
 *   opts.boldCols: column indexes drawn in bold
 * The header row is repeated when a table continues on a new page.
 */
function table(header, rows, colFractions, opts = {}) {
  const size = opts.size || 9.5;
  const statusCols = opts.statusCols || [];
  const boldCols = opts.boldCols || [];
  const fracs = colFractions || header.map(() => 1 / header.length);
  const widths = fracs.map((f) => f * CONTENT_W);
  const padX = 5;
  const padY = 4;
  const rowHeight = (cells, bold) => {
    let max = 0;
    cells.forEach((c, i) => {
      doc.font(bold || boldCols.includes(i) || statusCols.includes(i) ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
      const hh = doc.heightOfString(String(c), { width: widths[i] - padX * 2, lineGap: 1.5 });
      if (hh > max) max = hh;
    });
    return max + padY * 2;
  };
  const drawRow = (cells, { bold = false, fill = null, textColor = DARK } = {}) => {
    const h = rowHeight(cells, bold);
    let x = M;
    const rowY = y;
    cells.forEach((c, i) => {
      if (fill) doc.rect(x, rowY, widths[i], h).fill(fill);
      doc.rect(x, rowY, widths[i], h).lineWidth(0.5).strokeColor(BORDER).stroke();
      const isBold = bold || boldCols.includes(i);
      const font = isBold ? 'Helvetica-Bold' : 'Helvetica';
      const tw = widths[i] - padX * 2;
      if (!bold && statusCols.includes(i)) {
        let ty = rowY + padY;
        String(c).split('\n').forEach((line) => {
          doc.font('Helvetica-Bold').fontSize(size).fillColor(statusColor(line))
            .text(line, x + padX, ty, { width: tw, lineGap: 1.5 });
          ty = doc.y;
        });
      } else {
        doc.font(font).fontSize(size).fillColor(textColor)
          .text(String(c), x + padX, rowY + padY, { width: tw, lineGap: 1.5 });
      }
      x += widths[i];
    });
    y = rowY + h;
  };
  const drawHeader = () => {
    const h = rowHeight(header, true);
    need(h);
    drawRow(header, { bold: true, fill: GOLD, textColor: WHITE });
  };
  const firstData = rows.find((r) => Array.isArray(r)) || [''];
  need(rowHeight(header, true) + rowHeight(firstData, false) + 4);
  drawHeader();
  let n = 0;
  rows.forEach((r) => {
    if (!Array.isArray(r)) {
      const gh = 20;
      if (y + gh + 30 > BOTTOM) { newPage(); drawHeader(); }
      doc.rect(M, y, CONTENT_W, gh).fill(GOLD_SOFT);
      doc.rect(M, y, CONTENT_W, gh).lineWidth(0.5).strokeColor(BORDER).stroke();
      doc.font('Helvetica-Bold').fontSize(size + 1).fillColor(DARK)
        .text(r.group, M + padX, y + 5, { width: CONTENT_W - padX * 2, lineBreak: false });
      y += gh;
      n = 0;
      return;
    }
    const h = rowHeight(r, false);
    if (y + h > BOTTOM) { newPage(); drawHeader(); }
    drawRow(r, { fill: n % 2 ? LIGHT : WHITE });
    n += 1;
  });
  y += 10;
  doc.fillColor(DARK);
}

function callout(title, text, tone = 'gold') {
  const fill = tone === 'blue' ? BLUE_SOFT : tone === 'amber' ? AMBER_SOFT : tone === 'green' ? GREEN_SOFT : GOLD_SOFT;
  const bar = tone === 'blue' ? BLUE : tone === 'amber' ? AMBER : tone === 'green' ? GREEN : GOLD;
  const padX = 10;
  const padY = 8;
  const innerW = CONTENT_W - padX * 2 - 4;
  const titleH = measure(title, { font: 'Helvetica-Bold', size: 10, width: innerW, lineGap: 1 });
  const bodyH = measure(text, { font: 'Helvetica', size: 10, width: innerW, lineGap: 2 });
  const boxH = padY * 2 + titleH + 3 + bodyH;
  need(boxH + 8);
  const boxY = y;
  doc.rect(M, boxY, CONTENT_W, boxH).fill(fill);
  doc.rect(M, boxY, 4, boxH).fill(bar);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(title, M + padX + 4, boxY + padY, { width: innerW });
  doc.font('Helvetica').fontSize(10).fillColor(DARK).text(text, M + padX + 4, doc.y + 3, { width: innerW, lineGap: 2 });
  y = boxY + boxH + 10;
  doc.fillColor(DARK);
}

/** Row of equal-width scoreboard tiles: [{ big, label, color }] */
function tiles(items) {
  const gapW = 8;
  const w = (CONTENT_W - gapW * (items.length - 1)) / items.length;
  const h = 100;
  need(h + 10);
  const top = y;
  items.forEach((t, i) => {
    const x = M + i * (w + gapW);
    doc.rect(x, top, w, h).fill(LIGHT);
    doc.rect(x, top, w, 3).fill(t.color || GOLD);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(t.color || DARK)
      .text(t.big, x + 8, top + 12, { width: w - 16, lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(DARK)
      .text(t.label, x + 8, top + 38, { width: w - 16, lineGap: 1.5 });
  });
  y = top + h + 12;
  doc.fillColor(DARK);
}

// =============================================================================
// DATA
// =============================================================================

// 14 deliverables. access = true when going live needs access/connection to Urbani systems.
const DELIVERABLES = [
  { n: 1, name: 'Persistence (DynamoDB)', get: 'Users, audit, alerts and chat are stored in a managed AWS database. This removes the single-instance limit, so 2 or more instances can run.', access: true, need: 'AWS account and region, permission to create the database, approval to deploy.' },
  { n: 2, name: 'Role-based access (RBAC)', get: 'Four roles: Super Admin, Infrastructure Administrator, QA Operator, Reader/Auditor. Plus a user-management page.', access: false, need: 'Sign-off of the permission matrix (Appendix B).' },
  { n: 3, name: 'Audit log', get: 'Who did what, when, with what result, for configuration changes and sensitive queries. Searchable Audit page.', access: false, need: 'List of "sensitive" actions and the retention period.' },
  { n: 4, name: 'Log search & filters', get: 'Filter by severity, server, date range, text and regex, with paging. A CloudWatch Logs Insights connection is built and switched off.', access: true, need: 'Log-group names and read access for QA, Main, Payment (or an extension of the Urbani /logs endpoint).' },
  { n: 5, name: 'MFA + SSO', get: 'Authenticator-app MFA with recovery codes. Single sign-on (OIDC, e.g. Google Workspace via Cognito) built and switched off.', access: true, need: 'Identity-provider admin access, group-to-role mapping, SSO vs authenticator decision, MFA role policy.' },
  { n: 6, name: 'Alerts to email / Slack / Teams', get: 'Rules by severity and service, repeat-notification control, test-send, delivery log. Dry-run mode shows what would be sent.', access: true, need: 'Alert e-mail addresses, Slack/Teams webhook URLs, real rules, confirmation of the design (section 5).' },
  { n: 7, name: 'Chat feedback + history', get: 'Like/dislike on every answer, previous conversations can be reopened. Each user sees only their own history.', access: false, need: 'Retention period and privacy stance for stored questions.' },
  { n: 8, name: 'AI latency metric', get: 'Each answer shows how long it took, end to end (including the Urbani chat service). Stored with the answer.', access: false, need: 'Acceptable response time for live chat (real answers are slower than our test stand-in).' },
  { n: 9, name: 'Health / uptime panel', get: 'Status, uptime and history per target. QA, Main and Payment show WAITING FOR INTEGRATION until configured.', access: true, need: 'Health-check URLs and network reach for QA, Main, Payment.' },
  { n: 10, name: 'Branding + dark mode', get: 'Light, dark or system theme, remembered per user. Logo and palette are in place as placeholders.', access: false, need: 'Official logo (SVG/PNG), palette (hex), dark-mode guidance.' },
  { n: 11, name: 'Export CSV / JSON / PDF', get: 'Download logs (CSV, JSON, PDF), alerts (CSV, JSON) and a PDF incident report. Every export is audited.', access: false, need: 'Export size limits, whether Reader/Auditor may export, cloud file storage for large exports.' },
  { n: 12, name: 'Custom dashboard layout', get: 'Each user can reorder, hide and reset dashboard widgets. The layout is saved per user.', access: false, need: 'Which widgets may be personalised.' },
  { n: 13, name: 'Load & performance tests', get: 'Repeatable load scripts, a 200,000-line synthetic log test and a browser smoothness test.', access: true, need: 'Agreed performance targets, expected users, permission and a dedicated environment to test in.' },
  { n: 14, name: 'Deployment readiness', get: 'Scripts and settings to deploy DPI 2 as a separate parallel site, with 2 or more instances. Safe by default (dry-run).', access: true, need: 'Approval to deploy, operator access, hostname and DNS approval, rotated Urbani API key.' },
];

const ACCESS_COUNT = DELIVERABLES.filter((d) => d.access).length;
const DECISION_COUNT = DELIVERABLES.length - ACCESS_COUNT;

const B = 'Blocker for live';
const N = 'Needed before go-live';
const NH = 'Nice to have';

const NEEDS = [
  { group: 'Access & accounts' },
  ['AWS account, region and deployment permissions for DPI 2, including approval to deploy and operator access.', 'Lets us create the database, secrets store, service and alerts topic in Urbani\'s account.', '1, 6, 9, 14', B, 'AWS account owner'],
  ['Approval for a parallel test site on its own hostname (we propose dpi2.urbani.io), DNS approval and confirmation of the network and load-balancer details.', 'DPI 2 runs next to DPI 1. Nothing existing is disturbed.', '14', B, 'AWS account owner'],
  ['Rotate the previously shared Urbani API key and send the new one through a secure channel.', 'Closes a security carry-over from DPI 1. We store it in the secrets store only.', '4, 8, 14', B, 'Security lead'],
  ['A strong administrator password. We generate it and store it in the secrets store. Please confirm the DPI 1 default admin password is rotated or DPI 1 is retired.', 'Removes the default credential before real users arrive.', '2, 14', B, 'Security lead'],
  ['Log-group names and read access for QA, Main and Payment, or an extension of the Urbani /logs endpoint.', 'Enables full-stream search. Today only lines the Urbani service flags are searchable.', '4, 11', N, 'AWS account owner'],
  { group: 'Identity & security' },
  ['Admin access to Google Workspace (or the chosen identity provider) and the group-to-role mapping.', 'Completes single sign-on. People sign in with their corporate account and get the right role.', '2, 5', B, 'Google Workspace admin'],
  ['Decision: single sign-on, authenticator app, or both.', 'Decides whether the identity-provider work is needed at all.', '5', N, 'Security lead'],
  ['Which roles must use MFA. Draft: optional for everyone.', 'Turns on enforced MFA for the roles you name.', '5', N, 'Security lead'],
  ['Sign-off of the permission matrix (Appendix B).', 'Confirms who can see and do what. Role rules are enforced on the server.', '2', N, 'Product owner'],
  ['Whether Reader/Auditor may export, and whether auditors may ever read chat content (draft: no).', 'Sets export and chat privacy rules for the audit role.', '2, 7, 11', N, 'Security lead'],
  { group: 'Notification channels' },
  ['Alert e-mail addresses, and who confirms the subscription e-mails.', 'Required for real e-mail alerts.', '6', B, 'Operations lead'],
  ['Slack and/or Teams webhook URLs, sent through a secure channel (not e-mail or chat).', 'Required for real Slack/Teams alerts. Stored in the secrets store.', '6', B, 'Operations lead'],
  ['Alert rules: which severities and services notify, the repeat-notification (dedup) window and the hourly cap. Draft: High and above, 30 minutes, 30 per hour.', 'Avoids alert fatigue. Defaults can start immediately.', '6', N, 'Operations lead'],
  ['The public address of the dashboard, for links inside alerts.', 'Alert messages link straight to the incident.', '6', N, 'Operations lead'],
  { group: 'Monitoring targets' },
  ['Confirm what "QA, Main, Payment" mean as monitored targets (servers, services or environments, and where they run).', 'We cannot probe or search them without a clear definition.', '4, 9', B, 'Operations lead'],
  ['Health-check URLs for QA, Main and Payment, with the expected response and any sign-in needed.', 'Switches the panel from WAITING FOR INTEGRATION to live status.', '9', B, 'Operations lead'],
  ['Network reachability from the DPI 2 service to those URLs (or an internal route).', 'Probes must be able to reach the targets.', '9', B, 'AWS account owner'],
  { group: 'Branding' },
  ['Official logo (SVG and PNG, light and dark versions).', 'Replaces the placeholder logo.', '10', N, 'Brand/marketing'],
  ['Brand palette (hex values) and dark-mode guidance.', 'Replaces the placeholder colours and checks contrast.', '10', NH, 'Brand/marketing'],
  { group: 'Policies & decisions' },
  ['Audit-log retention (draft 365 days) and which actions count as "sensitive".', 'Sets how long audit records are kept and what is flagged.', '3', N, 'Security lead'],
  ['Chat-history retention (draft 90 days) and your stance on storing users\' questions.', 'Questions are stored as plain text per user today.', '7', N, 'Security lead'],
  ['Notification-log retention (draft 90 days).', 'Sets how long delivery records are kept.', '6', NH, 'Operations lead'],
  ['Health-history retention (draft 30 days).', 'Sets how much uptime history is kept.', '9', NH, 'Operations lead'],
  ['Export limits (draft 10,000 rows for CSV/JSON, 2,000 for PDF), retention of exported files, and whether large exports should use cloud file storage.', 'Protects the service from very large downloads.', '11', NH, 'Product owner'],
  ['Performance targets: response times, error rate, expected concurrent users, peak log volume, and an acceptable response time for live chat.', 'Today\'s thresholds are placeholders. Real targets make the tests meaningful.', '8, 13', N, 'Operations lead'],
  ['Permission to run load tests in a dedicated environment.', 'We never load-test production or Urbani\'s QA service without approval.', '13', N, 'AWS account owner'],
  ['Which dashboard widgets may be personalised, and whether an admin default layout is wanted.', 'Defines the personalisation scope.', '12', NH, 'Product owner'],
  ['Confirm the alert design: the dashboard service sends alerts itself (section 6). The original DynamoDB-Streams + Lambda design remains available.', 'One decision that shapes how alerts run in production.', '6', N, 'Product owner'],
  { group: 'Environment & rollout' },
  ['A named business sponsor.', 'The scope document leaves this open. Needed for acceptance.', 'All', N, 'Product owner'],
  ['Test users for each of the four roles.', 'Needed for user acceptance testing.', '2, 5', N, 'Product owner'],
  ['A cutover date and window, and the approval to retire DPI 1 afterwards.', 'DPI 1 keeps running untouched until you approve.', '14', N, 'Product owner'],
  ['Decision on DPI 1 data: start fresh or copy it into DPI 2.', 'DPI 1 data lives on a single instance; DPI 2 uses the new database.', '1, 14', N, 'Operations lead'],
];
const NEEDS_ROWS = NEEDS.filter((r) => Array.isArray(r));
NEEDS_ROWS.forEach((r, i) => r.unshift(String(i + 1)));
const BLOCKERS = NEEDS_ROWS.filter((r) => r[4] === B).length;

// =============================================================================
// COVER
// =============================================================================
function cover() {
  newPage();
  doc.rect(0, 0, PAGE_W, 300).fill(DARK);
  doc.rect(0, 300, PAGE_W, 6).fill(GOLD);
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(44).text('URBANI', M, 70, { lineBreak: false });
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(24)
    .text('Radar UrbiNexus -- DPI 2:', M, 140, { width: CONTENT_W, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(24)
    .text('Delivery Status & Client Requirements', M, 172, { width: CONTENT_W, lineBreak: false });
  doc.fillColor('#AEB6C2').font('Helvetica').fontSize(13)
    .text('What is delivered, what is pending, and what we need from Urbani', M, 232, { width: CONTENT_W, lineBreak: false });

  doc.fillColor(DARK).font('Helvetica-Bold').fontSize(13)
    .text('In one paragraph', M, 350, { width: CONTENT_W });
  doc.fillColor(GREY).font('Helvetica').fontSize(11).text(
    'All 14 planned DPI 2 deliverables are built and tested in our own environment. Connecting them to ' +
      'Urbani\'s real systems is pending the inputs listed in section 5. This document shows each deliverable, ' +
      'its honest status, and exactly what we need from your team.',
    M, 374, { width: CONTENT_W, lineGap: 4 },
  );

  const genDate = new Date().toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
  doc.fillColor(GREY).font('Helvetica').fontSize(10)
    .text(`Generated ${genDate} (UTC)`, M, 740, { width: CONTENT_W / 2, align: 'left', lineBreak: false });
  doc.text('Confidential -- prepared for Urbani', M + CONTENT_W / 2, 740, { width: CONTENT_W / 2, align: 'right', lineBreak: false });
}

// =============================================================================
// CONTENT
// =============================================================================
cover();
newPage(); // TOC reserved (page 2)
const tocPageIndex = pageNo - 1;
newPage(); // content starts page 3

// ---- 1. Executive summary ---------------------------------------------------
heading('1.', 'Executive Summary', 1);
para(
  'DPI 2 turns the DPI 1 dashboard into a secure, multi-user control center. It adds roles and sign-in ' +
    'protection, an audit trail, advanced log search and export, automatic alerts by e-mail, Slack and Teams, ' +
    'chat feedback and history, a health panel, Urbani branding with dark mode, and a deployment path that ' +
    'runs on more than one instance. It stays a read-only assistant with a human in the loop.',
);
callout(
  'Headline status',
  'All 14 planned deliverables are built and tested in our environment. Connecting them to Urbani\'s real ' +
    'systems is pending the inputs listed in section 5. Nothing has been run against Urbani\'s AWS account yet.',
  'green',
);
tiles([
  { big: '14 / 14', label: 'Deliverables built', color: GREEN },
  { big: '14 / 14', label: 'Verified in our own test environment', color: GREEN },
  { big: `${DELIVERABLES.length} of ${DELIVERABLES.length}`, label: `Awaiting Urbani input for full live operation (${ACCESS_COUNT} need access to Urbani systems, ${DECISION_COUNT} need decisions or assets)`, color: AMBER },
  { big: String(NEEDS_ROWS.length), label: `Inputs requested in section 5 (${BLOCKERS} are blockers for live)`, color: BLUE },
]);
heading('', 'The three most important asks', 2);
bullets([
  { label: '1. AWS access and deployment approval', text: 'account, region, permissions, and approval for a separate parallel test site. Nothing else can go live without it.' },
  { label: '2. Connection details for your systems', text: 'identity-provider admin access, log-group access and health-check URLs for QA, Main and Payment, and the alert e-mails and Slack/Teams webhooks.' },
  { label: '3. Security clean-up and sign-offs', text: 'rotate the shared Urbani API key, and sign off the permission matrix and the draft policy defaults (section 6).' },
]);

// ---- 2. How to read this document ------------------------------------------
heading('2.', 'How to Read This Document', 1);
heading('', 'Status legend', 2);
table(
  ['Status', 'What it means'],
  [
    ['Built and tested', 'The feature is built. We tested it in our own environment, using local stand-ins where a real Urbani or AWS service is needed.'],
    ['Awaiting Urbani input to go live', 'It cannot run against your real systems until you give us access, details or credentials.'],
    ['Decision needed', 'We chose a draft default so work could continue. Please confirm it or change it.'],
  ],
  [0.3, 0.7],
  { statusCols: [0] },
);
heading('', 'Data-honesty principle (kept from DPI 1)', 2);
para(
  'Every screen carries a provenance label. LIVE means real data from a real source. MOCK means sample data, ' +
    'clearly marked. WAITING FOR INTEGRATION means the source is not connected yet, so the screen says so ' +
    'instead of guessing. Nothing is ever fabricated, including logs, scores and AI answers.',
);
para(
  'The assistant is read-only. It explains and recommends. It never runs a fix on its own. A person decides ' +
    'and acts.',
);
callout(
  'What "tested" means here',
  'Where a feature needs a real service (AWS, Cognito, Google, Slack, Teams, SNS), we tested against a ' +
    'local stand-in or a simulated service. We do not claim any of these work against the real service until ' +
    'Urbani provides access and we verify them (see section 7).',
  'amber',
);

// ---- 3. Delivery status ----------------------------------------------------
heading('3.', 'Delivery Status by Deliverable', 1);
table(
  ['#', 'Deliverable', 'What you get', 'Status', 'Still needed to go live'],
  DELIVERABLES.map((d) => [
    String(d.n), d.name, d.get,
    d.access ? 'Built and tested\nAwaiting Urbani input' : 'Built and tested\nDecision needed',
    d.need,
  ]),
  [0.055, 0.15, 0.30, 0.15, 0.345],
  { size: 8.5, statusCols: [3], boldCols: [1] },
);

heading('3.1', 'Security & access', 2);
bullets([
  'Four roles control what each person can see and do. A Reader/Auditor cannot change configuration. This is enforced on the server and covered by automated tests per role.',
  'People can protect their sign-in with an authenticator app and recovery codes. Single sign-on is built and waits for your identity provider.',
  'Every configuration change and sensitive query is written to an audit log: who, what, when, result.',
  'The permission matrix is a draft until you sign it off (Appendix B).',
]);
heading('3.2', 'Log management & export', 2);
bullets([
  'Filter logs by severity, server, date range, text and regular expression, with paging.',
  'Download results as CSV, JSON or PDF, plus a PDF incident report. Each file states its source and whether it was cut short.',
  'Exports are limited in size, rate-limited and audited. Spreadsheet formulas in log text are neutralised.',
  'Full-stream search over Main and Payment waits for log access (section 5).',
]);
heading('3.3', 'Alerts & notifications', 2);
bullets([
  'Rules decide which severities and services notify, per channel: e-mail, Slack, Teams.',
  'A repeat-notification window stops the same incident from flooding channels.',
  'An administrator can send a test message per channel, and see a delivery log. Dry-run mode shows what would be sent without sending anything.',
  'Delivery to real e-mail, Slack and Teams is not yet verified. It needs your addresses and webhooks.',
]);
heading('3.4', 'AI Copilot', 2);
bullets([
  'Every answer has a like/dislike. A quality summary shows satisfaction and response times without exposing individual conversations.',
  'Previous conversations can be reopened. Each user sees only their own. Even a Super Admin cannot read someone else\'s chat.',
  'Each answer shows how long it took, end to end.',
]);
heading('3.5', 'Monitoring & health', 2);
bullets([
  'A Service Health page and a dashboard strip show status, uptime and history per target.',
  'The dashboard\'s own service is checked today. QA, Main and Payment show WAITING FOR INTEGRATION until you give us health-check URLs. They are never shown as live without a real check.',
  'Health probes are guarded so they cannot be pointed at internal cloud addresses by mistake.',
]);
heading('3.6', 'Experience', 2);
bullets([
  'Light, dark or system theme, remembered for each user. Colour contrast is checked automatically.',
  'Logo and palette are placeholders until Urbani provides the official assets.',
  'Each user can reorder, hide and reset dashboard widgets. The layout is saved per user and works on narrow screens.',
]);
heading('3.7', 'Platform & operations', 2);
bullets([
  'The database layer can run on DynamoDB. The existing database stays the default, so DPI 1 behaviour is unchanged.',
  'Deployment scripts create DPI 2 as a separate site with 2 or more instances across 2 availability zones. They do nothing unless explicitly told to apply, and they refuse to touch DPI 1.',
  'Load and performance scripts are ready, with placeholder targets. The deployment scripts have not yet been run against a real AWS account.',
]);

// ---- 4. Success criteria ---------------------------------------------------
heading('4.', 'Mapping to the DPI 2 Success Criteria', 1);
para('The eight success criteria come from the DPI 2 scope document. Each row says what we can show today and what remains.');
table(
  ['Success criterion', 'Status', 'Evidence we have today', 'What remains'],
  [
    ['1. Sign in with SSO/MFA and operate only with your role\'s permissions. A Reader/Auditor cannot change configuration.',
      'Built and tested\nAwaiting Urbani input',
      'MFA with authenticator app is complete. SSO via Google Workspace is built and tested against a simulated identity provider. Role rules are enforced on the server and tested per role.',
      'Urbani\'s identity-provider access, group-to-role mapping, and sign-off of the permission matrix.'],
    ['2. Configuration actions and sensitive queries appear in the audit log with user, action and time.',
      'Built and tested\nDecision needed',
      'Each event records user, role, action, target, time and result. Audit page with filters. Retention job. Tested on both database types (the DynamoDB type on a local test instance).',
      'List of sensitive actions and retention period. Not yet run on Urbani\'s real DynamoDB.'],
    ['3. Logs can be filtered by severity, server, date, searched by text/regex, and exported to CSV, JSON and PDF.',
      'Built and tested\nAwaiting Urbani input',
      'All filters, regex search and the three export formats work on the current sources. The Logs Insights connection is tested with a simulated service only.',
      'Log-group access for QA, Main, Payment for full-stream search. Until then the default source returns a limited window, so exports may be marked as cut short.'],
    ['4. A critical failure generates an alert by e-mail and in Slack or Teams.',
      'Built and tested\nAwaiting Urbani input',
      'Dry-run and test-send proven with simulated channels. Rules, repeat-notification control and delivery log tested.',
      'Real delivery needs e-mail addresses and Slack/Teams webhooks. Not yet verified against real channels.'],
    ['5. Each chat answer has like/dislike, past sessions can be consulted, and latency is shown.',
      'Built and tested\nDecision needed',
      'Feedback, session history and a latency figure per answer all work against our test stand-in for the chat service.',
      'Retention and privacy decision. Real latency not yet measured against the live Urbani chat service.'],
    ['6. The status panel shows QA, Main and Payment health. Without source access it is MOCK or WAITING FOR INTEGRATION, never LIVE.',
      'Awaiting Urbani input',
      'The panel and probes are built and tested against local servers. QA, Main and Payment show WAITING FOR INTEGRATION until health endpoints are provided. They are never shown as live.',
      'Health-check URLs and network reach for QA, Main and Payment.'],
    ['7. The interface stays smooth in a load test with massive log generation.',
      'Built and tested\nDecision needed',
      'Tests built and run on a development machine, including 200,000 synthetic log lines. The screen stayed smooth with 50,000 lines.',
      'Thresholds are placeholders until Urbani sets them. Tests have not run on AWS.'],
    ['8. The DPI 1 provenance model is preserved. Nothing is fabricated.',
      'Met\nBuilt and tested',
      'LIVE / MOCK / WAITING FOR INTEGRATION labels on every surface. Incident confidence is derived from severity and labelled "derived". The assistant stays read-only.',
      'Main and Payment stay labelled until they are connected.'],
  ],
  [0.25, 0.14, 0.34, 0.27],
  { size: 8.5, statusCols: [1] },
);

// ---- 5. What we need from Urbani -------------------------------------------
heading('5.', 'What We Need From Urbani', 1);
para(
  `This is the most important section. ${NEEDS_ROWS.length} inputs, grouped by topic. Priority: "${B}" means the ` +
    `feature cannot run for real without it. "${N}" means it must be settled before users start. "${NH}" ` +
    'can follow later. Owners are suggested roles, not named people.',
);
table(
  ['#', 'What we need', 'Why / what it unlocks', 'Items', 'Priority', 'Suggested owner'],
  NEEDS,
  [0.055, 0.30, 0.25, 0.09, 0.15, 0.155],
  { size: 8, boldCols: [4] },
);
callout(
  'Please send secrets through a secure channel',
  'Webhook URLs, the rotated API key and any credentials should never be sent by e-mail or chat. We will ' +
    'agree a secure hand-over and store them in the AWS secrets store only.',
  'amber',
);

// ---- 6. Decisions summary --------------------------------------------------
heading('6.', 'Decisions We Will Ask You to Confirm', 1);
para('We chose these draft defaults so work could continue. Each can be changed, mostly by configuration.');
table(
  ['Decision', 'Draft default we chose', 'Your options'],
  [
    ['Permission matrix', 'Four roles as in Appendix B. Reader/Auditor can view, export and use the chat but cannot change anything.', 'Adjust any role. For example, remove export or chat from Reader/Auditor.'],
    ['MFA policy', 'Optional for everyone.', 'Require MFA for chosen roles, or for all.'],
    ['Sign-in method', 'Local sign-in with optional authenticator app. SSO built and switched off.', 'SSO only, authenticator only, or both.'],
    ['Alert design', 'The dashboard service sends alerts itself. It works with the current database and DynamoDB, and is safe with several instances.', 'Keep it, or use the originally proposed DynamoDB-Streams + Lambda design. The alternative is available.'],
    ['Alert rules', 'High and above, all channels, same incident notified once per 30 minutes, at most 30 per hour.', 'Any severity, service or window.'],
    ['Retention', 'Audit 365 days. Chat history 90 days. Notification log 90 days. Health history 30 days.', 'Any period, or keep forever.'],
    ['Export limits', '10,000 rows for CSV/JSON. 2,000 rows for PDF.', 'Other limits, or cloud file storage for large exports.'],
    ['Parallel site', 'DPI 2 runs on its own hostname (proposed dpi2.urbani.io) next to DPI 1.', 'Another hostname.'],
    ['Chat privacy', 'Questions stored per user. Auditors cannot read chat content.', 'Turn history off, shorten retention, or allow auditor access.'],
    ['DPI 1 data', 'Not copied automatically.', 'Start fresh, or copy DPI 1 data into DPI 2.'],
  ],
  [0.2, 0.45, 0.35],
  { size: 8.5, boldCols: [0] },
);

// ---- 7. Test evidence ------------------------------------------------------
heading('7.', 'Test Evidence in Plain Language', 1);
table(
  ['Area', 'What we ran', 'Result'],
  [
    ['Automated tests', 'The full suite of automated checks on the application.', '641 tests pass. A further 104 database tests also pass against a local DynamoDB test instance.'],
    ['Browser checks', 'A browser walked through the screens in light and dark mode.', '43 checks across 15 screens passed. It found one real crash on the dashboard, which we fixed.'],
    ['Load: realistic', '50 simulated users on a development machine, 50,000 log lines, with pauses like real users.', 'No errors. 95th-percentile response times: reading 10 ms, search 18 ms, regex search 61 ms, export 99 ms, chat on a stand-in 24 ms.'],
    ['Load: large logs', '200,000 log lines, 25 users, search-heavy.', 'No errors. 95th-percentile: search 17 ms, regex 163 ms, export 46 ms. On a busy machine, up to about 0.5 s for search and 1.4 s for regex.'],
    ['Load: no pauses', 'Pushing 50 users with no pause on 200,000 lines.', 'Regex searches slowed to 1.4 - 2.3 s at the 95th percentile and two runs went past the draft limits. See section 9.'],
    ['Browser smoothness', 'Logs page with 50,000 lines, with and without background load.', 'First rows in about 0.4 - 0.5 s. No freeze longer than 50 ms during paging, filtering and typing.'],
    ['Security checks', 'Secrets scan, role-enforcement tests, input hardening.', 'Secrets scan clean. Role rules tested per role. Regex safety limits, export formula-injection protection and a webhook address allow-list are in place and tested.'],
  ],
  [0.17, 0.38, 0.45],
  { size: 8.5, boldCols: [0] },
);
callout(
  'Important: these are development-machine numbers',
  'The load figures come from a laptop-class development machine using sample data and local stand-ins. They ' +
    'are not AWS production numbers. The pass/fail thresholds are placeholders until Urbani sets real targets. ' +
    'The k6 and AWS Distributed Load Testing tools have not been run.',
  'amber',
);
callout(
  'What has NOT been verified yet',
  'Nothing was run against Urbani\'s AWS account. The deployment scripts have only been validated locally ' +
    '(dry-run and local containers). These are untested against real services: SSO with Google or Cognito; ' +
    'e-mail, Slack and Teams delivery; CloudWatch Logs Insights; Route 53 and Synthetics monitoring; real DynamoDB; ' +
    'and real chat latency.',
  'amber',
);

// ---- 8. Rollout plan -------------------------------------------------------
heading('8.', 'Rollout Plan', 1);
para('No dates are set. Timing depends on when Urbani\'s inputs arrive ("Pending Urbani input").');
table(
  ['Step', 'What happens', 'Done when'],
  [
    ['0. Collect inputs', 'We gather the items in section 5 and agree a secure hand-over for secrets.', 'Blockers for live are received.'],
    ['1. Parallel deploy', 'DPI 2 is deployed as a separate site next to DPI 1 on its own hostname. Nothing existing is disturbed.', 'The DPI 2 site is reachable and healthy on 2 instances.'],
    ['2. Connect integrations', 'Each integration is switched on as its input arrives. This is configuration, not new development. Each is checked against a checklist.', 'Each integration passes its check with real data.'],
    ['3. Acceptance testing', 'Test users, one per role, try the system against the success criteria.', 'Urbani signs off acceptance.'],
    ['4. Cutover', 'The main address is pointed at DPI 2 and DPI 1 is retired. Rollback is simple: point the address back.', 'Urbani approves cutover and retirement.'],
  ],
  [0.2, 0.52, 0.28],
  { size: 9, boldCols: [0] },
);
callout(
  'DPI 1 is not touched',
  'DPI 1 keeps running exactly as it does today until Urbani approves cutover. Our deployment scripts refuse ' +
    'to change DPI 1 resources.',
  'green',
);

// ---- 9. Known limitations --------------------------------------------------
heading('9.', 'Known Limitations and Recommendations', 1);
bullets([
  { label: 'Run 2 or more instances', text: 'The service handles load on one processor core per instance. DPI 2 is planned for 2 or more instances with automatic scaling.' },
  { label: 'Very large log volumes', text: 'Use CloudWatch Logs Insights for search over large volumes. Our in-service search is fine for moderate volumes, but regex search slows under heavy load.' },
  { label: 'Dashboard summary caching', text: 'If many people watch the dashboard at once, caching the summary for a few seconds would help. We have not turned it on.' },
  { label: 'Regex search is bounded', text: 'On purpose. Patterns are checked for safety and time-limited, so one bad pattern cannot slow the service for everyone.' },
  { label: 'Main and Payment stay labelled', text: 'Anything that depends on Main or Payment data stays marked WAITING FOR INTEGRATION until those systems are connected.' },
  { label: 'Incident confidence is derived', text: 'The "confidence" shown on incidents is calculated from severity and clearly labelled as derived. It is not a model score.' },
  { label: 'Limits per instance', text: 'Request rate limits are kept in memory on each instance, so they multiply with the number of instances.' },
  { label: 'Chat latency', text: 'Real AI answers are slower than our stand-in. Please set an acceptable response time (section 5).' },
]);

// ---- Appendix A ------------------------------------------------------------
heading('Appendix A:', 'Target Architecture Diagram', 1);
if (fs.existsSync(DIAGRAM)) {
  const imgW = CONTENT_W;
  const imgH = imgW * (DIAGRAM_PX.h / DIAGRAM_PX.w);
  need(imgH + 50);
  doc.image(DIAGRAM, M, y, { width: imgW, height: imgH });
  doc.rect(M, y, imgW, imgH).lineWidth(0.5).strokeColor(BORDER).stroke();
  y += imgH + 6;
}
para(
  'Grey shows the DPI 1 base. Orange shows what is new in DPI 2 (identity, database, notifications and ' +
    'health monitoring). Orange services are proposals to confirm with Urbani. Ingestion from Main and Payment ' +
    'depends on access to those sources.',
  { oblique: true, color: GREY, size: 9.5 },
);

// ---- Appendix B ------------------------------------------------------------
heading('Appendix B:', 'DRAFT Role Permission Matrix', 1);
para('Draft for Urbani sign-off. The same matrix is used by the server and the screens.');
table(
  ['Capability', 'Super Admin', 'Infra Admin', 'QA Operator', 'Reader / Auditor'],
  [
    ['View dashboard, alerts, logs, metrics, services, AI insights, usage, settings', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Acknowledge alerts', 'Yes', 'Yes', 'Yes', 'No'],
    ['Run AI analysis on an incident', 'Yes', 'Yes', 'Yes', 'No'],
    ['Use the chat assistant (read-only advice)', 'Yes', 'Yes', 'Yes', 'Yes (judgement call)'],
    ['Export logs, alerts and incident reports', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Manage alert rules and send test notifications', 'Yes', 'Yes', 'No', 'No'],
    ['Change settings and run a health check now', 'Yes', 'Yes', 'No', 'No'],
    ['View the audit log and chat quality summary', 'Yes', 'Yes', 'No', 'Yes'],
    ['Manage users and roles', 'Yes', 'No', 'No', 'No'],
  ],
  [0.4, 0.14, 0.14, 0.14, 0.18],
  { size: 8.5, boldCols: [0] },
);
para(
  'Chat conversations are private to each user. Nobody, including a Super Admin, can read another person\'s ' +
    'conversation. Urbani may remove chat or export from Reader/Auditor.',
  { oblique: true, color: GREY, size: 9.5 },
);

// ---- Appendix C ------------------------------------------------------------
heading('Appendix C:', 'Glossary', 1);
table(
  ['Term', 'Meaning'],
  [
    ['RBAC', 'Role-based access control: what a person can do depends on their role.'],
    ['SSO', 'Single sign-on: people sign in once with their corporate account.'],
    ['MFA / TOTP', 'Multi-factor sign-in. TOTP is the six-digit code from an authenticator app.'],
    ['Audit log', 'A record of who did what, and when. It has no edit or delete option, only the retention clean-up.'],
    ['Dedup', 'Repeat-notification control: the same incident is announced once per time window.'],
    ['DynamoDB', 'Amazon\'s managed database service. It replaces the single-instance database used in DPI 1.'],
    ['ECS Fargate', 'The AWS service that runs the dashboard in containers without managing servers.'],
    ['Provenance label', 'The tag on every screen saying where data comes from: LIVE, MOCK or WAITING FOR INTEGRATION.'],
    ['Logs Insights', 'The CloudWatch feature for searching the full stream of log lines at scale.'],
  ],
  [0.22, 0.78],
  { size: 9, boldCols: [0] },
);

// =============================================================================
// TABLE OF CONTENTS (second pass)
// =============================================================================
doc.switchToPage(tocPageIndex);
let ty = TOP;
doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK).text('Table of Contents', M, ty, { lineBreak: false });
ty += 28;
doc.moveTo(M, ty).lineTo(PAGE_W - M, ty).lineWidth(1.4).strokeColor(GOLD).stroke();
ty += 18;
for (const entry of toc) {
  const isTop = entry.level === 1;
  const size = isTop ? 11.5 : 10;
  const rowH = isTop ? 22 : 16;
  const indent = isTop ? 0 : 20;
  const titleX = M + indent;
  const pageStr = String(entry.page);
  doc.font(isTop ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(isTop ? DARK : GREY);
  const pageW = doc.widthOfString(pageStr);
  const titleW = doc.widthOfString(entry.title);
  doc.text(entry.title, titleX, ty, { lineBreak: false });
  const dotsStart = titleX + titleW + 5;
  const dotsEnd = PAGE_W - M - pageW - 5;
  if (dotsEnd > dotsStart) {
    doc.fillColor(DOT);
    const dotW = doc.widthOfString('.');
    const n = Math.max(0, Math.floor((dotsEnd - dotsStart) / dotW));
    doc.text('.'.repeat(n), dotsStart, ty, { lineBreak: false });
  }
  doc.font(isTop ? 'Helvetica-Bold' : 'Helvetica').fillColor(isTop ? DARK : GREY)
    .text(pageStr, PAGE_W - M - pageW, ty, { lineBreak: false });
  ty += rowH;
}

// =============================================================================
// FOOTERS
// =============================================================================
const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i++) {
  doc.switchToPage(i);
  const printed = i + 1;
  if (printed === 1) continue;
  doc.lineWidth(0.5).strokeColor(BORDER).moveTo(M, FOOT_Y - 4).lineTo(PAGE_W - M, FOOT_Y - 4).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
    .text(FOOTER_TITLE, M, FOOT_Y, { width: CONTENT_W * 0.7, align: 'left', lineBreak: false });
  doc.text(`Page ${printed} of ${range.count}`, M + CONTENT_W * 0.7, FOOT_Y, { width: CONTENT_W * 0.3, align: 'right', lineBreak: false });
}

doc.end();
console.log(`DPI 2 delivery status PDF generated at: ${OUT_FILE}`);
console.log(`Total pages: ${range.count}`);
console.log(`TOC entries: ${toc.length}`);
console.log(`Needs rows: ${NEEDS_ROWS.length} (blockers: ${BLOCKERS})`);
