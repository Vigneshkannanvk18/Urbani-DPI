/* =============================================================================
 * gen-docs.js — Generates OUTPUT/Urbani_DPI_Documentation.pdf
 *
 * A complete, client-facing documentation PDF for the Urbani Proactive
 * Observability & AI Troubleshooting Assistant. Built with pdfkit (pure JS).
 *
 * Content is grounded in the ACTUAL codebase, config, and deployment script —
 * what the system really does today: live Urbani QA logs/alerts/chat via API
 * Gateway, SQLite persistence, deterministic LIVE/MOCK/WAITING provenance, and
 * an ECS Fargate deployment.
 *
 * Design principles (learned the hard way):
 *   - NEVER write text past the bottom content margin — that silently spawns
 *     blank pages. A single `flow()` primitive measures height and page-breaks
 *     deliberately before drawing.
 *   - The cover is drawn in a bounded region (y <= coverLimit); nothing on it
 *     ever triggers an auto page break.
 *   - The TOC is a two-pass render: content records each heading's page as it
 *     draws, then the TOC is written onto a reserved page with one row per line.
 *   - Footers are stamped in a final pass over the exact buffered page range,
 *     always ABOVE the bottom edge, so they add no pages.
 *
 * Run:  npm run gen:docs   (or: node scripts/gen-docs.js)
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

const OUT_DIR = path.join(__dirname, '..', 'OUTPUT');
const OUT_FILE = path.join(OUT_DIR, 'Urbani_DPI_Documentation.pdf');
const DIAGRAM = path.join(OUT_DIR, 'Urbani_AWS_Architecture_Diagram.png');

// ---- Page geometry (A4 portrait, pt) ---------------------------------------
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 56; // uniform margin
const TOP = M;
const BOTTOM = PAGE_H - M; // hard content bottom; nothing is drawn below this
const CONTENT_W = PAGE_W - M * 2;
const FOOT_Y = PAGE_H - M + 16; // footer baseline (below content, inside page)

const doc = new PDFDocument({
  size: 'A4',
  // Bottom margin is intentionally tiny so footer text drawn near the page edge
  // never triggers PDFKit's auto page-break. Content layout uses our own BOTTOM
  // constant (M from the edge), not this margin, so the body still stops at M.
  margins: { top: M, bottom: 8, left: M, right: M },
  bufferPages: true,
  autoFirstPage: false,
  info: {
    Title: 'Urbani DPI — Project Documentation',
    Author: 'Urbani Observability',
    Subject: 'Proactive Observability & AI Troubleshooting Assistant',
  },
});
doc.pipe(fs.createWriteStream(OUT_FILE));

// y is OUR cursor; we never rely on PDFKit's implicit flow for body content.
let y = TOP;
let pageNo = 0; // 1-based current page
const toc = []; // { title, level, page }

// =============================================================================
// Core layout primitives
// =============================================================================

/** Start a new page and reset the cursor. */
function newPage() {
  doc.addPage();
  pageNo += 1;
  y = TOP;
}

/** Break to a new page if `h` pt would not fit before BOTTOM. */
function need(h) {
  if (y + h > BOTTOM) newPage();
}

/**
 * Measure a text block's height for the given font/size/width, WITHOUT drawing.
 * Returns height in pt.
 */
function measure(text, { font = 'Helvetica', size = 10.5, width = CONTENT_W, lineGap = 2.5 } = {}) {
  doc.font(font).fontSize(size);
  return doc.heightOfString(text, { width, lineGap });
}

/**
 * Draw a flowing text block at the current cursor, page-breaking first if it
 * does not fit. Advances y. Long blocks that exceed a full page are allowed to
 * flow across pages (PDFKit handles the wrap; we re-sync y afterwards).
 */
function flow(text, opts = {}) {
  const font = opts.bold ? 'Helvetica-Bold' : opts.oblique ? 'Helvetica-Oblique' : 'Helvetica';
  const size = opts.size || 10.5;
  const width = opts.width || CONTENT_W;
  const x = opts.x != null ? opts.x : M;
  const lineGap = opts.lineGap != null ? opts.lineGap : 2.5;
  const h = measure(text, { font, size, width, lineGap });

  // If it fits on the current page, draw at y. If not and it's small, break.
  // If it's taller than a full page, let it flow from the top of a fresh page.
  if (y + h > BOTTOM) {
    if (h <= BOTTOM - TOP) newPage();
    else need(0);
  }
  doc.font(font).fontSize(size).fillColor(opts.color || DARK)
    .text(text, x, y, { width, align: opts.align || 'left', lineGap });
  // Re-sync our cursor to wherever PDFKit ended (handles multi-line + any wrap).
  y = doc.y;
  y += opts.after != null ? opts.after : 6;
}

/** Vertical spacer. */
function gap(h) {
  y += h;
  if (y > BOTTOM) newPage();
}

/** Section (level 1) or subsection (level 2) heading. Records a TOC entry. */
function heading(number, title, level = 1) {
  const label = number ? `${number}  ${title}` : title;
  const blockH = level === 1 ? 30 : 20;
  need(blockH + 10);
  if (level === 1 && y > TOP + 2) gap(8); // breathing room before a new section
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

/** Paragraph. */
function para(text, opts = {}) {
  flow(text, { ...opts, after: opts.after != null ? opts.after : 8 });
}

/** Bullet list. Items are strings or { label, text }. */
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
    doc.font('Helvetica-Bold').fontSize(size).fillColor(GOLD).text('•', M + 4, rowY, { lineBreak: false });
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

/** Table with header + rows. colFractions sum ~1. Rows page-break individually. */
function table(header, rows, colFractions) {
  const fracs = colFractions || header.map(() => 1 / header.length);
  const widths = fracs.map((f) => f * CONTENT_W);
  const padX = 6;
  const padY = 5;

  const rowHeight = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    let max = 0;
    cells.forEach((c, i) => {
      const hh = doc.heightOfString(String(c), { width: widths[i] - padX * 2, lineGap: 1.5 });
      if (hh > max) max = hh;
    });
    return max + padY * 2;
  };

  const drawRow = (cells, { bold = false, fill = null, textColor = DARK } = {}) => {
    const h = rowHeight(cells, bold);
    need(h);
    const rowY = y;
    let x = M;
    cells.forEach((c, i) => {
      if (fill) doc.rect(x, rowY, widths[i], h).fill(fill);
      doc.rect(x, rowY, widths[i], h).lineWidth(0.5).strokeColor(BORDER).stroke();
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(textColor)
        .text(String(c), x + padX, rowY + padY, { width: widths[i] - padX * 2, lineGap: 1.5 });
      x += widths[i];
    });
    y = rowY + h;
  };

  // Keep the header with at least the first row.
  need(rowHeight(header, true) + rowHeight(rows[0] || [''], false));
  drawRow(header, { bold: true, fill: GOLD, textColor: WHITE });
  rows.forEach((r, i) => {
    // When a row will not fit, break first and repeat the header so a continued table stays readable.
    if (y + rowHeight(r, false) > BOTTOM) {
      newPage();
      drawRow(header, { bold: true, fill: GOLD, textColor: WHITE });
    }
    drawRow(r, { fill: i % 2 ? LIGHT : WHITE });
  });
  y += 10;
  doc.fillColor(DARK);
}

/** Callout box. */
function callout(title, text) {
  const padX = 10;
  const padY = 8;
  const innerW = CONTENT_W - padX * 2 - 4;
  const titleH = measure(title, { font: 'Helvetica-Bold', size: 10, width: innerW, lineGap: 1 });
  const bodyH = measure(text, { font: 'Helvetica', size: 10, width: innerW, lineGap: 2 });
  const boxH = padY * 2 + titleH + 3 + bodyH;
  need(boxH + 8);
  const boxY = y;
  doc.rect(M, boxY, CONTENT_W, boxH).fill(GOLD_SOFT);
  doc.rect(M, boxY, 4, boxH).fill(GOLD);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK)
    .text(title, M + padX + 4, boxY + padY, { width: innerW });
  doc.font('Helvetica').fontSize(10).fillColor(DARK)
    .text(text, M + padX + 4, doc.y + 3, { width: innerW, lineGap: 2 });
  y = boxY + boxH + 10;
  doc.fillColor(DARK);
}

// =============================================================================
// COVER
// =============================================================================
function cover() {
  newPage(); // page 1
  // Banner.
  doc.rect(0, 0, PAGE_W, 258).fill(DARK);
  doc.rect(0, 258, PAGE_W, 6).fill(GOLD);

  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(44).text('URBANI', M, 64, { lineBreak: false });
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(19).text('Proactive Observability &', M, 124, { lineBreak: false });
  doc.text('AI Troubleshooting Assistant', M, 150, { lineBreak: false });
  doc.fillColor('#AEB6C2').font('Helvetica').fontSize(12).text('Project Documentation', M, 196, { lineBreak: false });

  // Subtitle (bounded height so it cannot overflow into the diagram).
  doc.fillColor(DARK).font('Helvetica-Bold').fontSize(13)
    .text('Complete System & Deployment Documentation', M, 296, { width: CONTENT_W });
  doc.fillColor(GREY).font('Helvetica').fontSize(10.5).text(
    'This document describes the delivered Urbani observability platform: its architecture, features, ' +
      'live AWS data integration, Google sign-in, roles and audit, automatic notifications, service health, ' +
      'export, and the ECS Fargate deployment, together with an honest status of what is verified and what ' +
      'is still pending. All content reflects the implemented system.',
    M, 320, { width: CONTENT_W, lineGap: 3 },
  );

  // Diagram, scaled to a fixed box well above the footer.
  if (fs.existsSync(DIAGRAM)) {
    const imgW = CONTENT_W;
    const imgH = imgW * (2840 / 5404); // ~254pt
    const imgY = 430;
    doc.image(DIAGRAM, M, imgY, { width: imgW, height: imgH });
    doc.rect(M, imgY, imgW, imgH).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fillColor(GREY).font('Helvetica-Oblique').fontSize(8.5)
      .text('Target AWS architecture: ECS Fargate dashboard + serverless incident pipeline.',
        M, imgY + imgH + 5, { width: CONTENT_W, align: 'center', lineBreak: false });
  }

  // Cover footer (fixed, above the page edge).
  const genDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.fillColor(GREY).font('Helvetica').fontSize(9)
    .text(`Generated ${genDate}`, M, 760, { width: CONTENT_W / 2, align: 'left', lineBreak: false });
  doc.text('Confidential — prepared for client distribution', M + CONTENT_W / 2, 760, { width: CONTENT_W / 2, align: 'right', lineBreak: false });
}

// =============================================================================
// DOCUMENT CONTENT
// =============================================================================
cover();

// Reserve the TOC page (page 2), filled in the second pass.
newPage();
const tocPageIndex = pageNo - 1; // 0-based buffer index

// Content begins on page 3.
newPage();

// ---- 1. Executive Overview --------------------------------------------------
heading('1.', 'Executive Overview', 1);
para(
  'The Urbani Proactive Observability & AI Troubleshooting Assistant is a custom web platform that gives ' +
    'operations teams a single, honest view of their service health. It surfaces live logs and AI-generated ' +
    'incident alerts from the Urbani QA environment and provides an in-context AI assistant (the "Urbani ' +
    'Copilot") that answers questions grounded in the real log and incident evidence. It is advisory and ' +
    'human-in-the-loop: the platform never performs automated remediation.',
);
para('The delivered platform includes:');
bullets([
  { label: 'Dashboard, alerts and logs', text: 'health summary, alerts/incidents list and detail, advanced log search, metrics, services, usage and cost, and settings views.' },
  { label: 'Live AWS data', text: 'real logs and AI-generated incidents from the Urbani QA API Gateway, with the Copilot answering through Amazon Bedrock (Nova 2 Lite) server-side.' },
  { label: 'Secure access', text: 'password sign-in and Google single sign-on, optional authenticator-app MFA, four roles with a permission matrix, user management and an append-only audit log.' },
  { label: 'Automatic notifications', text: 'alert rules that send e-mail (Google Workspace SMTP or Amazon SNS), Slack and Microsoft Teams messages, with a safe dry-run mode and a delivery log.' },
  { label: 'Operations tooling', text: 'service health and uptime panel, log and alert export (CSV, JSON, PDF), Copilot history and feedback, a personalised dashboard, corporate branding with dark mode, and load-test tooling.' },
  { label: 'Honest provenance', text: 'every data surface is labelled LIVE, MOCK or WAITING_FOR_INTEGRATION so viewers always know the source of what they see.' },
  { label: 'Production deployment', text: 'containerized frontend and backend on ECS Fargate behind an Application Load Balancer with TLS, served at a dedicated domain.' },
]);
callout(
  'How to read the status of each capability',
  'Every capability in this document is built and covered by automated tests. A few depend on AWS access or ' +
    'on inputs only Urbani can provide, and have not yet been exercised against the real service. Section 10 ' +
    'lists, per capability, what is verified, what is pending, and what Urbani is asked to supply.',
);

// ---- 2. System Architecture -------------------------------------------------
heading('2.', 'System Architecture', 1);
para(
  'The application is a TypeScript monorepo with three packages: a shared types library, an Express ' +
    'backend, and a React (Vite) single-page frontend. In production the two runnable components run as one ' +
    'ECS Fargate task: an nginx container serves the SPA and reverse-proxies API calls to the backend ' +
    'container over the shared task network.',
);
heading('2.1', 'Request flow', 2);
para(
  'The browser only ever talks to the frontend origin. nginx serves the SPA at "/" and proxies "/api/*" to ' +
    'the backend on port 4000; the backend host is never exposed directly. The backend reads live data ' +
    'through a strict adapter boundary, so the data source can change without any change to the API ' +
    'contract, the dashboard, or business logic.',
);
heading('2.2', 'Components', 2);
table(
  ['Component', 'Technology', 'Role'],
  [
    ['Frontend', 'React 18 + Vite, served by nginx', 'SPA dashboard; reverse-proxies /api to the backend. The only browser-facing component (port 8080).'],
    ['Backend', 'Node.js 20 + Express', 'REST API, authentication and authorisation, live-data adapters, notification engine, health prober, persistence (port 4000).'],
    ['Shared', 'TypeScript library', 'Common contracts, roles and permissions used by both backend and frontend.'],
    ['Persistence', 'SQLite (default) or DynamoDB', 'Users, preferences, audit, chat history, alerts, notification rules and log, health results. The driver is chosen by one setting; both pass the same contract tests.'],
    ['Identity', 'Google (OpenID Connect)', 'Optional single sign-on. Users authenticate at Google; roles are assigned inside the platform.'],
    ['Incident pipeline', 'AWS CDK (EventBridge, Lambda, Bedrock, DynamoDB)', 'Serverless pipeline that generates incidents upstream (infrastructure-as-code).'],
  ],
  [0.2, 0.28, 0.52],
);
heading('2.3', 'Background services inside the backend', 2);
table(
  ['Service', 'What it does', 'Control'],
  [
    ['Notification engine', 'Polls alerts on a schedule, matches rules, de-duplicates and sends e-mail, Slack and Teams messages.', 'NOTIFICATIONS_ENABLED, ALERT_POLL_MINUTES (5)'],
    ['Health prober', 'Probes configured health endpoints once a minute and stores UP / DEGRADED / DOWN results.', 'HEALTH_PROBES_ENABLED, HEALTH_PROBE_INTERVAL_SECONDS (60)'],
    ['Retention jobs', 'Daily purge of audit events, chat history, notification log and health results past their retention period.', 'AUDIT_RETENTION_DAYS, CHAT_RETENTION_DAYS and others'],
  ],
  [0.22, 0.52, 0.26],
);

// ---- 3. Application Features ------------------------------------------------
heading('3.', 'Application Features', 1);
heading('3.1', 'Pages and navigation', 2);
para('Navigation items and buttons are shown according to the signed-in role; the API enforces the same rules.');
table(
  ['Page', 'Purpose'],
  [
    ['Dashboard', 'Service health strip, key metrics, system health, AI cost and budget, recent alerts and analyses. Each user can reorder and hide sections.'],
    ['Alerts / Incidents', 'AI-generated incidents with severity, anomaly type, confidence, evidence and recommended actions; acknowledge; export; per-incident PDF report.'],
    ['Logs', 'Advanced log search by severity, server, date range, text or regex, with pagination and export.'],
    ['Metrics, Services, Usage & Cost', 'Supporting operational views, each with an honest source label.'],
    ['AI Insights and Urbani Copilot', 'Incident analyses and the grounded chat assistant, with history, feedback and a quality card.'],
    ['Service Health', 'Uptime and status per monitored target over 24 hours, 7 days or 30 days.'],
    ['Notifications', 'Channel status, alert rules, "Check connection" and "Send test", and the delivery log.'],
    ['Audit', 'Searchable, append-only record of configuration changes and sensitive queries.'],
    ['Users', 'Super Admin only: create users, assign roles, activate and deactivate.'],
    ['Security', 'Each user manages their own authenticator-app MFA and recovery codes.'],
    ['Settings', 'Read-only view of the environment-driven configuration. No secrets are exposed.'],
  ],
  [0.28, 0.72],
);
heading('3.2', 'Urbani Copilot (AI assistant)', 2);
para(
  'The Copilot answers operational questions ("Are there any errors right now?", "Summarize the current ' +
    'logs") grounded in the real log window and incident evidence. In live mode the question is sent to the ' +
    'Urbani QA chat endpoint, which grounds the answer server-side on Amazon Bedrock (Nova 2 Lite) across ' +
    'recent log windows and alerts. The assistant is advisory only and never takes action.',
);
bullets([
  { label: 'History', text: 'every exchange is stored per user; users can resume, rename and delete past conversations.' },
  { label: 'Feedback', text: 'users can like or dislike each answer and leave a short comment.' },
  { label: 'Latency', text: 'the end-to-end time of each answer is stored and shown.' },
  { label: 'Quality card', text: 'roles that can view the audit log see satisfaction, counts, latency percentiles and recent dislike comments on the AI Insights page.' },
  { label: 'Privacy', text: 'conversations are owner-only. Another user\'s session is never readable, not even by a Super Admin. Retention is configurable (placeholder: 90 days).' },
]);
callout(
  'Chat vs. Logs scope',
  'The Copilot is grounded server-side across both recent logs and incident alerts, so it may describe an ' +
    'incident that the currently-filtered log window does not list. The assistant surfaces a short grounding ' +
    'note making this scope explicit, so the two views are never mistaken for contradicting each other.',
);
heading('3.3', 'Log search and export', 2);
para(
  'Logs can be filtered by severity, server, date range and text, or searched with a regular expression. ' +
    'Regular expressions are validated against known catastrophic patterns and run under a strict time ' +
    'budget, so a search can never stall the service. Every search is audited (filters only, never content).',
);
table(
  ['Export', 'Formats', 'Notes'],
  [
    ['Logs', 'CSV, JSON, PDF', 'Uses exactly the filters on screen. CSV is Excel-friendly (UTF-8 with BOM) and protected against formula injection.'],
    ['Alerts', 'CSV, JSON', 'Filtered by severity, service, status, date.'],
    ['Incident report', 'PDF', 'One incident with its evidence and recommended actions.'],
  ],
  [0.22, 0.2, 0.58],
);
para(
  'Every export states its source (LIVE, MOCK or WAITING), the scope searched, the filters applied, the row ' +
    'count and whether it was truncated. Limits are configurable (placeholders: 10,000 rows for CSV and JSON, ' +
    '2,000 rows for PDF, 10 exports per minute per user). Each export is audited. Exported files are not stored.',
);
heading('3.4', 'Service health and uptime', 2);
para(
  'The Service Health page and a status strip on the Dashboard show UP, DEGRADED or DOWN for each target, ' +
    'with uptime over 24 hours, 7 days or 30 days. Targets are the platform itself, the Urbani telemetry API, ' +
    'and the QA, Main and Payment applications. Targets without a configured health URL show ' +
    'WAITING_FOR_INTEGRATION and are never presented as healthy. Uptime is shown as "insufficient data" until ' +
    'enough samples exist, never as a fake 100%. Probe URLs come only from configuration, and requests to ' +
    'cloud metadata and link-local addresses are always blocked.',
);
heading('3.5', 'Dashboard personalisation', 2);
para(
  'Each user can reorder and hide Dashboard sections (key metrics, service health, system health, AI cost, ' +
    'observability chart, recent alerts, recent analyses) with drag and drop or keyboard buttons. The layout ' +
    'is saved per user and can be reset to the default. Sections a user is not permitted to see are never shown.',
);
heading('3.6', 'Branding and dark mode', 2);
para(
  'The interface uses the Urbani logo and colour palette. Users choose System, Light or Dark and the choice ' +
    'is remembered, with no flash on load. Text and interface colours are checked automatically against ' +
    'WCAG AA contrast ratios in both themes.',
);

// ---- 4. Live Data Integration ----------------------------------------------
heading('4.', 'Live Data Integration', 1);
para(
  'The backend integrates with the Urbani QA API Gateway (secured by an x-api-key, called server-side only). ' +
    'Three live data paths are wired through the adapter boundary:',
);
table(
  ['Data', 'Upstream source', 'Behaviour'],
  [
    ['Logs', 'GET /logs/latest + /logs/history per service', 'Live log lines, merged latest + history, de-duplicated, newest-first, filterable. Optionally the full CloudWatch Logs Insights stream (LOGS_SOURCE=insights).'],
    ['Incidents', 'GET /alerts/latest + /alerts/history', 'AI-generated incidents; their evidence lines are correlated back to the Logs view.'],
    ['Chat', 'POST /chat (Amazon Bedrock Nova 2 Lite)', 'Server-side grounded answer across recent logs + alerts; raw lines never cross the wire.'],
    ['Metrics, services detail, usage and cost', 'Not provisioned upstream', 'Served as clearly-labelled sample data (MOCK), never claimed LIVE.'],
  ],
  [0.2, 0.36, 0.44],
);
heading('4.1', 'Log evidence correlation', 2);
para(
  'The upstream /logs endpoints currently return only "relevant" (flagged) lines, so the real log content ' +
    'arrives inside each incident\'s evidence. The backend parses that evidence, preserving original ' +
    'timestamps, inferring levels, and keeping message text verbatim, and surfaces it on the Logs view and ' +
    'in each alert\'s detail. This keeps the Logs view populated with genuine upstream data and gives every ' +
    'incident verifiable backing evidence. Nothing is ever fabricated.',
);
heading('4.2', 'Incident confidence', 2);
para(
  'The upstream incident source does not report a model confidence score. Rather than show an empty value, ' +
    'the system derives a confidence from incident severity and labels it clearly as "(derived)" in the UI, ' +
    'with an explanatory tooltip, so it is never mistaken for a model-reported score.',
);

// ---- 5. Access Control & Security ------------------------------------------
heading('5.', 'Access Control and Security', 1);
heading('5.1', 'Sign-in methods', 2);
table(
  ['Method', 'How it works'],
  [
    ['Password', 'Email and password (minimum 10 characters, stored as a bcrypt hash). A signed session token lasts 8 hours by default. Kept as a break-glass login even when Google sign-in is on.'],
    ['Google single sign-on', 'Users authenticate at Google; the platform never sees the Google password. Optional, switched on by configuration.'],
  ],
  [0.24, 0.76],
);
heading('5.2', 'Google single sign-on', 2);
para('Google proves who the user is. The platform decides whether they may enter and what they may do.');
bullets([
  { label: 'Standards', text: 'OpenID Connect authorization-code flow with PKCE. The platform verifies the signature, issuer, audience, expiry and nonce of the Google ID token, and requires a verified e-mail address.' },
  { label: 'Domain restriction', text: 'only e-mail addresses on the allowed domain list may sign in (comma-separated list, exact match).' },
  { label: 'No self-registration', text: 'a user must already exist on the Users page, created by a Super Admin with a role. A Google account that is not on the list is denied, even inside the allowed domain.' },
  { label: 'Roles stay in the platform', text: 'the role a Super Admin chose is used at every sign-in. Deactivating a user blocks their next request.' },
  { label: 'Break-glass administrator', text: 'a local password administrator remains available so the platform can never lock itself out.' },
]);
heading('5.3', 'Multi-factor authentication', 2);
bullets([
  { label: 'Authenticator app', text: 'time-based one-time codes (TOTP), enrolled from the Security page with a QR code.' },
  { label: 'Recovery codes', text: 'one-time codes for lost devices, which can be regenerated.' },
  { label: 'Policy', text: 'MFA can be made mandatory for chosen roles. Users in a mandatory role are forced to enrol at first sign-in.' },
  { label: 'Protection', text: 'secrets are stored encrypted; repeated wrong codes lock the account for 15 minutes; a Super Admin can reset MFA for a locked-out user (audited).' },
  { label: 'Google users', text: 'multi-factor protection for Google sign-in is enforced by Google (2-Step Verification on the Workspace domain).' },
]);
heading('5.4', 'Roles and permissions', 2);
para('The permission matrix below is a DRAFT pending Urbani sign-off. It is defined in one place and read by both the API and the UI.');
table(
  ['Permission', 'Super Admin', 'Infra Admin', 'QA Operator', 'Reader / Auditor'],
  [
    ['View dashboard, alerts, logs, metrics, services, AI insights, usage, settings', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Use Copilot chat (advisory)', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Export logs, alerts, incident report', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Acknowledge alerts, run AI analysis', 'Yes', 'Yes', 'Yes', 'No'],
    ['Manage alert rules, update settings', 'Yes', 'Yes', 'No', 'No'],
    ['View audit log', 'Yes', 'Yes', 'No', 'Yes'],
    ['Manage users', 'Yes', 'No', 'No', 'No'],
  ],
  [0.4, 0.15, 0.15, 0.15, 0.15],
);
para(
  'Enforcement is on the server for every request: the user is loaded on each call, so a role change or ' +
    'deactivation applies immediately. Blocked attempts return 403 and are written to the audit log.',
);
heading('5.5', 'User management', 2);
para(
  'Super Admins create users on the Users page with an e-mail address, name and role. The password can be ' +
    'left empty for Google-only users. Guard rails: the last active Super Admin cannot be demoted or ' +
    'deactivated, and nobody can change their own role or deactivate themselves.',
);
heading('5.6', 'Audit log', 2);
para(
  'The audit log is an append-only record with no edit or delete endpoint. It records sign-ins and failures, ' +
    'Google sign-ins and denials, user and role changes, alert acknowledgements, settings changes, searches, ' +
    'exports, chat queries and permission denials. Passwords, tokens, API keys and secrets are redacted before ' +
    'storage, and searches record filters only, never log content. Each event holds the actor, role, ' +
    'IP address, correlation id and result. Retention is configurable (placeholder: 365 days).',
);
heading('5.7', 'Secrets and data protection', 2);
bullets([
  { label: 'Secrets', text: 'the session signing secret, MFA encryption key, Urbani API key, Google client secret and SMTP password are injected from AWS Secrets Manager at deploy time, never baked into images or source.' },
  { label: 'Server-side API key', text: 'the Urbani x-api-key is used only server-side; it is never logged, returned in responses, or sent to the browser.' },
  { label: 'Webhook URLs', text: 'Slack and Teams URLs are secrets and are only accepted for allow-listed hosts.' },
  { label: 'Transport', text: 'TLS terminates at the load balancer; session cookies for Google sign-in are HttpOnly, SameSite and Secure.' },
]);
heading('5.8', 'Honest provenance model', 2);
para('Every data surface carries a source badge so viewers always know what they are looking at:');
table(
  ['Label', 'Meaning'],
  [
    ['LIVE', 'Real data fetched from the Urbani QA environment.'],
    ['MOCK', 'Deterministic sample data for a capability not yet provisioned upstream (for example metrics and usage and cost).'],
    ['WAITING_FOR_INTEGRATION', 'A live source is configured but temporarily unavailable, or a target has no endpoint configured. Shown instead of a silent empty state.'],
  ],
  [0.34, 0.66],
);
callout(
  'No fabrication',
  'The system never invents log lines or AI answers. When a live window is genuinely empty it says so; when ' +
    'an upstream call fails it degrades to an honest "temporarily unavailable" state. This honesty guarantee ' +
    'is enforced throughout the codebase and by tests.',
);

// ---- 6. Alert Notifications -------------------------------------------------
heading('6.', 'Automatic Alert Notifications', 1);
para(
  'The platform notifies the right people automatically when a matching alert appears, so incidents do not ' +
    'wait for someone to open the dashboard.',
);
heading('6.1', 'How it works', 2);
bullets([
  { label: 'Rules', text: 'a rule has a minimum severity, optional services and anomaly types, and the channels to use. A default rule sends Critical and High alerts to all configured channels (DRAFT pending Urbani input).' },
  { label: 'Schedule', text: 'new alerts are checked every 5 minutes and after each live alert refresh.' },
  { label: 'De-duplication and limits', text: 'the same alert is never sent twice on a channel, a per-channel hourly cap prevents floods, and alerts older than the configured age (60 minutes) are not sent.' },
  { label: 'Message', text: 'severity, service, environment, anomaly type, summary, probable cause, confidence (labelled derived), time, and a link that opens the alert in the dashboard.' },
  { label: 'Reliability', text: 'up to three attempts with growing delays; temporary errors are retried, permanent rejections are not.' },
]);
heading('6.2', 'Channels', 2);
table(
  ['Channel', 'Delivery', 'Set-up'],
  [
    ['E-mail', 'Google Workspace SMTP (smtp.gmail.com, STARTTLS) or Amazon SNS topic.', 'Sender account with an app password stored in Secrets Manager. SMTP takes priority over SNS when configured.'],
    ['Slack', 'Incoming webhook with formatted blocks and an "Open in dashboard" button.', 'Webhook URL stored as a secret.'],
    ['Microsoft Teams', 'Workflows webhook with an Adaptive Card (legacy connectors also supported).', 'Webhook URL stored as a secret.'],
  ],
  [0.18, 0.46, 0.36],
);
heading('6.3', 'E-mail recipients by role', 2);
para(
  'E-mail goes to every active user whose role is on the configured list (currently Super Admin, QA ' +
    'Operator and Infrastructure Administrator), read from the Users page at the moment of sending. Adding a ' +
    'user or changing a role takes effect on the next alert with no restart. Fixed extra addresses can also ' +
    'be configured. Addresses on non-deliverable domains are skipped and duplicates are removed.',
);
heading('6.4', 'Safe rollout and delivery log', 2);
bullets([
  { label: 'Dry run', text: 'in dry-run mode nothing is sent; what would have been sent is written to the delivery log so rules and recipients can be reviewed first.' },
  { label: 'Check connection', text: 'for e-mail, signs in to the mail server without sending anything.' },
  { label: 'Send test', text: 'sends a clearly-labelled test message through a channel.' },
  { label: 'Delivery log', text: 'every attempt with its channel, status (sent, failed, dry run, skipped), time and reason, with a configurable retention period.' },
]);

// ---- 7. Deployment ----------------------------------------------------------
heading('7.', 'Deployment: AWS ECS Fargate', 1);
para(
  'The application is deployed to ECS Fargate as a single task running two containers (frontend + backend) ' +
    'behind an Application Load Balancer, with TLS terminated at the ALB and the dashboard served at a ' +
    'dedicated domain. Both container images build from the repository root and are pushed to ECR.',
);
heading('7.1', 'Runtime topology', 2);
table(
  ['Setting', 'Value'],
  [
    ['Platform', 'AWS ECS Fargate (serverless containers), awsvpc networking'],
    ['Task size', '0.5 vCPU / 1 GB (512 CPU / 1024 MiB), desired count 1'],
    ['Frontend container', 'nginx + React SPA, port 8080 (ALB target)'],
    ['Backend container', 'Node/Express, port 4000, reached at 127.0.0.1:4000 within the task'],
    ['Load balancer', 'Application Load Balancer, HTTPS :443 (ACM certificate), HTTP to HTTPS redirect'],
    ['Persistence', 'SQLite at /data/urbani.sqlite (single writer, so one task). Data survives a redeploy only if /data is persistent storage (see section 10).'],
    ['Secrets', 'Session secret, MFA key, Urbani API key, seed admin password, Google client secret and SMTP password from AWS Secrets Manager'],
    ['Outbound access', 'Urbani API Gateway, Amazon Bedrock, Google (sign-in) and smtp.gmail.com on port 587 (e-mail)'],
    ['Logs', 'CloudWatch Logs with per-container stream prefixes; 30-day retention'],
  ],
  [0.26, 0.74],
);
heading('7.2', 'Deploy sequence', 2);
bullets([
  'Create ECR repositories and build + push the backend and frontend images from the repo root.',
  'Register the ECS task definition (two containers, environment and secrets wired, health checks, awslogs).',
  'Create/attach the ALB target group and listener rules (HTTPS forward + HTTP to HTTPS redirect).',
  'Create or update the ECS service with deployment circuit-breaker and automatic rollback.',
  'Point the domain at the ALB via a Route 53 alias record.',
]);
heading('7.3', 'Health checks', 2);
bullets([
  { label: 'GET /health', text: 'liveness: always 200 when the process is up (used by the container and ALB health check).' },
  { label: 'GET /ready', text: 'readiness: verifies the database is reachable; returns 503 if not.' },
  { label: 'Frontend /healthz', text: 'nginx liveness target for the container health check.' },
]);
heading('7.4', 'Configuration reference', 2);
para('All behaviour is environment-driven. Secrets are referenced by Secrets Manager name only.');
table(
  ['Area', 'Main settings'],
  [
    ['Core', 'INTEGRATION_MODE (mock | live), URBANI_API_BASE_URL, URBANI_SERVICES, DB_DRIVER (sqlite | dynamodb), JWT_EXPIRES_IN'],
    ['Sign-in', 'AUTH_PROVIDER (local | oidc), AUTH_LOCAL_ENABLED, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_ALLOWED_EMAIL_DOMAIN, OIDC_AUTO_PROVISION, MFA_REQUIRED_ROLES'],
    ['Notifications', 'NOTIFICATIONS_ENABLED, NOTIFICATIONS_DRY_RUN, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM, ALERT_EMAIL_ROLES, ALERT_EMAIL_TO, DASHBOARD_BASE_URL'],
    ['Health', 'HEALTH_TARGETS, HEALTH_PROBES_ENABLED, HEALTH_PROBE_INTERVAL_SECONDS, HEALTH_RETENTION_DAYS'],
    ['Retention', 'AUDIT_RETENTION_DAYS, CHAT_RETENTION_DAYS, NOTIFICATIONS_LOG_RETENTION_DAYS'],
    ['Export', 'EXPORT_MAX_ROWS, EXPORT_PDF_MAX_ROWS, EXPORT_RATE_LIMIT_PER_MIN, EXPORT_TIMEOUT_MS'],
    ['Secrets', 'JWT_SECRET, MFA_ENCRYPTION_KEY, SEED_ADMIN_PASSWORD, URBANI_API_KEY, OIDC_CLIENT_SECRET, SMTP_PASSWORD'],
  ],
  [0.2, 0.8],
);

// ---- 8. Operations ----------------------------------------------------------
heading('8.', 'Operations and Maintenance', 1);
bullets([
  { label: 'Zero-downtime deploys', text: 'the ECS service uses a deployment circuit breaker with rollback and keeps healthy capacity during deploys, so a bad image rolls back automatically.' },
  { label: 'Observability', text: 'container logs stream to CloudWatch with separate frontend/backend prefixes; the backend emits structured JSON logs.' },
  { label: 'Configuration', text: 'switching between mock and live data is a single INTEGRATION_MODE setting with no code change.' },
  { label: 'Retention', text: 'daily jobs purge audit events, chat history, notification log and health results after their configured periods.' },
  { label: 'Leavers', text: 'deactivate the user on the Users page (effective on their next request) and also suspend the account in Google Workspace.' },
  { label: 'Secret rotation', text: 'rotate any secret that has been shared outside Secrets Manager; the service reads secrets at start-up, so redeploy after rotation.' },
  { label: 'Rollback', text: 'set AUTH_PROVIDER=local to turn Google sign-in off, clear SMTP_HOST or set NOTIFICATIONS_ENABLED=false to stop e-mail. Stored data is not touched.' },
]);
callout(
  'Security action before go-live',
  'The bootstrap admin password and the Urbani API key must be strong values in AWS Secrets Manager ' +
    '(not development defaults), and the previously shared Urbani API key should be rotated. The break-glass ' +
    'administrator should use an address that cannot sign in with Google, and MFA should be required for ' +
    'privileged local logins.',
);

// ---- 9. Quality & Testing ---------------------------------------------------
heading('9.', 'Quality and Testing', 1);
para(
  'The backend is covered by an automated test suite that runs as part of the build, with more than 650 ' +
    'tests passing. Coverage includes the live log and alert adapters, evidence parsing and correlation, ' +
    'authentication and MFA, Google sign-in against a simulated identity provider, role enforcement on every ' +
    'route, audit, export, health probing, notification channels and rules, and the chat grounding flow. The ' +
    'full build compiles the shared, backend and frontend packages cleanly, and the frontend passes a strict ' +
    'TypeScript type check.',
);
bullets([
  { label: 'Contract tests', text: 'the same repository tests run against both SQLite and DynamoDB.' },
  { label: 'Honest-data tests', text: 'specific tests assert that empty or absent upstream data never produces fabricated output.' },
  { label: 'Security tests', text: 'role enforcement, secret redaction, regular-expression safety, export formula injection and probe address blocking.' },
  { label: 'Accessibility', text: 'an automatic contrast check of the colour tokens in both themes against WCAG AA, plus keyboard-operable controls. Full accessibility validation still requires manual testing with assistive technologies.' },
  { label: 'Load tests', text: 'k6 scenarios and a Node runner for read, search, export, login and chat traffic. Thresholds are drafts awaiting agreed targets.' },
  { label: 'Deployment checks', text: 'an automatic check that the deployment configuration matches what the backend reads and contains no secret values.' },
]);

// ---- 10. Delivery status & open items --------------------------------------
heading('10.', 'Delivery Status and Open Items', 1);
para(
  'This section states plainly what has been exercised and what has not. The running system today uses ' +
    'live Urbani logs, alerts and the Copilot. Items marked pending have been built and tested with ' +
    'simulated services but not yet exercised against the real AWS or third-party service.',
);
heading('10.1', 'Status by capability', 2);
table(
  ['Capability', 'Built and tested', 'Pending verification'],
  [
    ['Live logs, alerts, Copilot', 'Yes', 'In production use'],
    ['Roles, user management, audit', 'Yes', 'Permission matrix sign-off by Urbani'],
    ['Google sign-in', 'Yes (simulated provider; real Google login confirmed on a local environment)', 'Production sign-in with the Urbani Workspace domain'],
    ['Authenticator-app MFA', 'Yes', 'MFA policy decision by Urbani'],
    ['E-mail notifications (SMTP)', 'Yes (mail server login confirmed locally)', 'Delivery of a real alert e-mail in production'],
    ['Slack and Teams notifications', 'Yes (simulated)', 'Webhook URLs from Urbani, real test message'],
    ['Service health panel', 'Yes (local test servers)', 'Health URLs for QA, Main and Payment'],
    ['Log search on CloudWatch Logs Insights', 'Yes (simulated AWS)', 'Log group names and read access'],
    ['Export, personalisation, branding', 'Yes', 'Export limits and widget scope confirmed by Urbani'],
    ['DynamoDB persistence', 'Yes (DynamoDB Local)', 'Table, permissions and approval to deploy'],
    ['Metrics, services detail, usage and cost', 'Sample data (labelled MOCK)', 'Upstream AWS endpoints from Urbani'],
  ],
  [0.34, 0.33, 0.33],
);
heading('10.2', 'Before real users are added', 2);
bullets([
  { label: 'Persistent storage', text: 'the database file must live on persistent storage (for example Amazon EFS) or the platform must move to DynamoDB. On ephemeral task storage every redeploy would erase users, audit history and preferences.' },
  { label: 'Single instance', text: 'while SQLite is used, exactly one task runs, so a deployment briefly interrupts service. DynamoDB removes this limit and allows two or more tasks across two availability zones.' },
  { label: 'Secrets', text: 'Google client secret and mail app password created for production and stored only in Secrets Manager; any value shared outside it rotated.' },
  { label: 'Dry run first', text: 'review the notification delivery log in dry-run mode, then switch it off after "Check connection" and "Send test" succeed.' },
]);
heading('10.3', 'Inputs requested from Urbani', 2);
table(
  ['Item', 'Needed'],
  [
    ['Workspace domain(s) allowed to sign in', 'Domain list'],
    ['First Super Admin and the policy for creating Super Admins', 'Google e-mail address and policy'],
    ['Alert recipients', 'Confirm the roles that receive e-mail and any fixed addresses'],
    ['Role permission matrix', 'Sign-off, including whether auditors may export'],
    ['MFA policy', 'Which roles must use MFA'],
    ['Health check URLs for QA, Main and Payment', 'URLs and network reachability from the service'],
    ['Retention and privacy', 'Audit, chat and notification log periods; chat PII policy'],
    ['Slack and Teams', 'Webhook URLs, if those channels are wanted'],
    ['Metrics, usage and billing', 'AWS endpoints to replace sample data'],
    ['Load-test targets', 'Agreed response-time thresholds and expected traffic'],
    ['Urbani API key', 'Confirmation that the previously shared key was rotated'],
  ],
  [0.55, 0.45],
);

// ---- 11. Roadmap ------------------------------------------------------------
heading('11.', 'Roadmap and Next Steps', 1);
para('Natural extensions beyond the delivered system, each fitting the existing architecture without rework:');
bullets([
  { label: 'DynamoDB persistence', text: 'switch the live service to the built DynamoDB driver for durable, multi-task operation.' },
  { label: 'High availability', text: 'run two or more tasks across two availability zones with auto scaling once persistence allows concurrent writers.' },
  { label: 'Live metrics, services and cost', text: 'promote these views from sample data to LIVE when the upstream endpoints exist.' },
  { label: 'Group-based roles', text: 'optionally derive roles from Google Workspace groups instead of manual assignment.' },
  { label: 'Invitation e-mail', text: 'send new users a welcome message with the sign-in link when a Super Admin creates them.' },
  { label: 'Large exports', text: 'stage very large exports in S3 and return a pre-signed link.' },
  { label: 'Native Bedrock analysis', text: 'wire the in-app Bedrock pipeline for on-demand analysis behind the existing provider interface.' },
]);

// ---- 12. Glossary -----------------------------------------------------------
heading('12.', 'Glossary', 1);
table(
  ['Term', 'Definition'],
  [
    ['ALB', 'Application Load Balancer: the public entry point that terminates TLS and routes to the service.'],
    ['ECS Fargate', 'Serverless container runtime; no servers to manage, capacity set as task CPU/memory.'],
    ['SSO', 'Single sign-on: signing in with an existing Google account instead of a separate password.'],
    ['OIDC / PKCE', 'OpenID Connect and Proof Key for Code Exchange: the standard, secure protocol used for Google sign-in.'],
    ['MFA / TOTP', 'Multi-factor authentication using time-based one-time codes from an authenticator app.'],
    ['RBAC', 'Role-based access control: what each user may see and do depends on their role.'],
    ['Break-glass administrator', 'A local password account kept for emergencies when Google sign-in is unavailable.'],
    ['Dry run', 'A notification mode that records what would be sent without sending anything.'],
    ['SMTP', 'The standard protocol for sending e-mail; here used with Google Workspace.'],
    ['Provenance badge', 'The LIVE / MOCK / WAITING_FOR_INTEGRATION label shown on every data surface.'],
    ['Copilot', 'The in-app AI assistant that answers questions grounded in live logs and incidents.'],
    ['Incident evidence', 'The real log lines attached to an AI-generated incident, used as backing proof.'],
    ['Nova 2 Lite', 'The Amazon Bedrock model used to generate incident analysis and Copilot answers.'],
    ['Secrets Manager', 'AWS service that stores passwords and keys so they never appear in code or images.'],
  ],
  [0.26, 0.74],
);

// =============================================================================
// TABLE OF CONTENTS (second pass onto the reserved page)
// =============================================================================
doc.switchToPage(tocPageIndex);
let ty = TOP;
doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK).text('Table of Contents', M, ty, { lineBreak: false });
ty += 28;
doc.moveTo(M, ty).lineTo(PAGE_W - M, ty).lineWidth(1.4).strokeColor(GOLD).stroke();
ty += 18;

const tocNeeded = toc.reduce((s, e) => s + (e.level === 1 ? 20 : 16), 0);
const tocScale = Math.min(1, (BOTTOM - ty) / tocNeeded);
for (const entry of toc) {
  const isTop = entry.level === 1;
  const size = isTop ? 11.5 : 10;
  const rowH = (isTop ? 20 : 16) * tocScale;
  const indent = isTop ? 0 : 20;
  const titleX = M + indent;
  const pageStr = String(entry.page);

  doc.font(isTop ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(isTop ? DARK : GREY);
  const pageW = doc.widthOfString(pageStr);
  const titleW = doc.widthOfString(entry.title);

  // Title (left).
  doc.text(entry.title, titleX, ty, { lineBreak: false });
  // Dotted leader between title and page number.
  const dotsStart = titleX + titleW + 5;
  const dotsEnd = PAGE_W - M - pageW - 5;
  if (dotsEnd > dotsStart) {
    doc.fillColor(DOT);
    const dotW = doc.widthOfString('.');
    const n = Math.max(0, Math.floor((dotsEnd - dotsStart) / dotW));
    doc.text('.'.repeat(n), dotsStart, ty, { lineBreak: false });
  }
  // Page number (right).
  doc.font(isTop ? 'Helvetica-Bold' : 'Helvetica').fillColor(isTop ? DARK : GREY)
    .text(pageStr, PAGE_W - M - pageW, ty, { lineBreak: false });

  ty += rowH;
}

// =============================================================================
// FOOTERS (final pass over the exact buffered range; adds no pages)
// =============================================================================
const range = doc.bufferedPageRange(); // { start, count }
for (let i = range.start; i < range.start + range.count; i++) {
  doc.switchToPage(i);
  const printed = i + 1;
  if (printed === 1) continue; // no footer on the cover
  doc.lineWidth(0.5).strokeColor(BORDER).moveTo(M, FOOT_Y - 4).lineTo(PAGE_W - M, FOOT_Y - 4).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
    .text('Urbani Proactive Observability & AI Troubleshooting Assistant', M, FOOT_Y, { width: CONTENT_W / 2, align: 'left', lineBreak: false });
  doc.text(`Page ${printed} of ${range.count}`, M + CONTENT_W / 2, FOOT_Y, { width: CONTENT_W / 2, align: 'right', lineBreak: false });
}

doc.end();
console.log(`Documentation PDF generated at: ${OUT_FILE}`);
console.log(`Total pages: ${range.count}`);
console.log(`TOC entries: ${toc.length}`);
