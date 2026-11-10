/* =============================================================================
 * gen-dpi2-docs.js — Generates OUTPUT/Urbani_DPI2_Plan.pdf
 *
 * Client-facing DPI 2 ("Radar UrbiNexus") plan, gap analysis, and client-input
 * requirements. Built with pdfkit, reusing the exact layout approach proven in
 * scripts/gen-docs.js (flow() measures before drawing so no blank pages; the
 * TOC is a second pass onto a reserved page; footers are stamped last).
 *
 * Content is sourced from docs/DPI2_PLAN_AND_GAP_ANALYSIS.md, which was built by
 * reading the two client documents (DPI2_Urbani_UrbiNexus_EN.docx and
 * Upgrades_UrbiNexus_DPI_EN.pdf) and mapping them against the delivered DPI 1
 * system. Honesty rule preserved: the delivered baseline (SQLite + CDK
 * scaffolding) is stated plainly; nothing is over-claimed.
 *
 * Run:  npm run gen:dpi2   (or: node scripts/gen-dpi2-docs.js)
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

const OUT_DIR = path.join(__dirname, '..', 'OUTPUT');
const OUT_FILE = path.join(OUT_DIR, 'Urbani_DPI2_Plan.pdf');
const DIAGRAM = path.join(OUT_DIR, 'Urbani_AWS_Architecture_Diagram.png');

// ---- Page geometry (A4 portrait, pt) ---------------------------------------
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 56;
const TOP = M;
const BOTTOM = PAGE_H - M;
const CONTENT_W = PAGE_W - M * 2;
const FOOT_Y = PAGE_H - M + 16;

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: M, bottom: 8, left: M, right: M },
  bufferPages: true,
  autoFirstPage: false,
  info: {
    Title: 'Urbani Radar UrbiNexus — DPI 2 Plan',
    Author: 'Urbani Observability',
    Subject: 'DPI 2 Plan, Gap Analysis & Client Requirements',
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
  need((level === 1 ? 30 : 20) + 10);
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
  need(rowHeight(header, true) + rowHeight(rows[0] || [''], false));
  drawRow(header, { bold: true, fill: GOLD, textColor: WHITE });
  rows.forEach((r, i) => drawRow(r, { fill: i % 2 ? LIGHT : WHITE }));
  y += 10;
  doc.fillColor(DARK);
}

function callout(title, text, tone = 'gold') {
  const fill = tone === 'blue' ? BLUE_SOFT : GOLD_SOFT;
  const bar = tone === 'blue' ? '#2E6FD6' : GOLD;
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

// =============================================================================
// COVER
// =============================================================================
function cover() {
  newPage();
  doc.rect(0, 0, PAGE_W, 258).fill(DARK);
  doc.rect(0, 258, PAGE_W, 6).fill(GOLD);
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(44).text('URBANI', M, 60, { lineBreak: false });
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(19).text('Radar UrbiNexus — DPI 2', M, 120, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(15).text('Plan, Gap Analysis & Client Requirements', M, 150, { lineBreak: false });
  doc.fillColor('#AEB6C2').font('Helvetica').fontSize(12).text('Proactive Observability & AI Troubleshooting Assistant', M, 198, { lineBreak: false });

  doc.fillColor(DARK).font('Helvetica-Bold').fontSize(13)
    .text('From MVP to a Secure, Scalable Control Center', M, 296, { width: CONTENT_W });
  doc.fillColor(GREY).font('Helvetica').fontSize(10.5).text(
    'This document maps the DPI 2 scope (Radar UrbiNexus) against the delivered DPI 1 system: what was ' +
      'built, what must be upgraded, what is new, and exactly what we need from Urbani to proceed. It covers ' +
      'RBAC and SSO/MFA, DynamoDB persistence, advanced log management and export, email/Slack/Teams alerts, ' +
      'chatbot feedback and history, health KPIs, branding and dark mode. The DPI 1 provenance model ' +
      '(LIVE / MOCK / WAITING_FOR_INTEGRATION) is preserved — no data or answers are fabricated.',
    M, 320, { width: CONTENT_W, lineGap: 3 },
  );

  if (fs.existsSync(DIAGRAM)) {
    const imgW = CONTENT_W;
    const imgH = imgW * (2840 / 5404);
    const imgY = 440;
    doc.image(DIAGRAM, M, imgY, { width: imgW, height: imgH });
    doc.rect(M, imgY, imgW, imgH).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fillColor(GREY).font('Helvetica-Oblique').fontSize(8.5)
      .text('DPI 1 architecture baseline. DPI 2 adds Cognito, DynamoDB, SNS/Slack/Teams and Synthetics (see Section 4).',
        M, imgY + imgH + 5, { width: CONTENT_W, align: 'center', lineBreak: false });
  }

  const genDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.fillColor(GREY).font('Helvetica').fontSize(9)
    .text(`Generated ${genDate}`, M, 760, { width: CONTENT_W / 2, align: 'left', lineBreak: false });
  doc.text('Confidential — prepared for Urbani', M + CONTENT_W / 2, 760, { width: CONTENT_W / 2, align: 'right', lineBreak: false });
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
  'DPI 2 takes the DPI 1 MVP — a working, honest observability dashboard on the Urbani QA environment, a ' +
    'Bedrock Nova 2 Lite incident pipeline, and the read-only AI Copilot — and turns it into a secure, ' +
    'multi-user, multi-service control center ready to scale. The headline changes:',
);
bullets([
  { label: 'Security becomes multi-user', text: 'granular RBAC (4 roles), SSO + MFA (Cognito / Google Workspace), and an audit log. Today: single-level JWT with one bootstrap admin.' },
  { label: 'Persistence moves to DynamoDB', text: 'removes the single-writer limit and enables 2+ ECS tasks across AZs. Today: SQLite, single task.' },
  { label: 'Log management gets serious', text: 'severity/server/date/text/regex filtering, full-stream search (CloudWatch Logs Insights), CSV/JSON/PDF export. Today: only flagged lines, no full-stream search or export.' },
  { label: 'Monitoring expands QA -> Main + Payment', text: 'subject to client access, plus a health/uptime panel and email + Slack/Teams alerts.' },
  { label: 'Chatbot gets evaluation + memory', text: 'like/dislike feedback, conversation history, visible end-to-end latency.' },
  { label: 'UX gets brand identity', text: 'Urbani logo and palette, dark mode, rearrangeable widgets.' },
]);
para(
  'The DPI 2 scope estimates ~64 h of effort (about 4 builders over 2 days) across a 13-item backlog ' +
    '(P0/P1/P2). A large share of the work is blocked on client inputs — identity-provider access, ' +
    'Main/Payment log access, notification webhooks, and branding assets (see Section 6).',
);
callout(
  'Honest starting point',
  'Parts of the DPI 2 "already exists" list describe the target production shape. In the delivered DPI 1 the ' +
    'dashboard runs on ECS Fargate, but the running app persists to SQLite, and the incident/alert pipeline ' +
    'Lambdas are CDK scaffolding (placeholders), not deployed. DPI 2 is where DynamoDB persistence and the ' +
    'notifier pipeline are actually built. We will align this with Urbani so expectations match reality.',
  'blue',
);

// ---- 2. What DPI 2 asks for -------------------------------------------------
heading('2.', 'What DPI 2 Asks For', 1);
heading('2.1', 'Objectives', 2);
bullets([
  { label: 'Security & access control', text: 'granular RBAC with SSO/MFA and an audit log.' },
  { label: 'Log management & monitoring', text: 'advanced filters + real-time search (severity, server QA/Main/Payment, date range, keywords/regex), export (CSV/JSON/PDF), and automatic alerts by email, Slack or Teams.' },
  { label: 'AI chatbot', text: 'measure usefulness (feedback), keep conversation history, show response latency.' },
  { label: 'Infrastructure KPIs', text: 'health-check/uptime panel for QA, Main, Payment; validate the UI stays smooth under load.' },
  { label: 'User experience', text: 'Urbani corporate identity (logo + palette), dark mode, personalizable dashboard widgets.' },
  { label: 'Traceability', text: 'verify the full deliverable sequence for 100% roadmap coverage.' },
]);
heading('2.2', 'Success criteria (the DPI is "successful if…")', 2);
bullets([
  'A user authenticates via SSO/MFA and operates only with their role\u2019s permissions; a Reader/Auditor cannot modify configuration (validated with per-role test cases).',
  'Configuration actions and sensitive queries are recorded in the audit log with user, action and timestamp.',
  'Logs can be filtered (severity, server, date), searched (text/regex), and exported to CSV, JSON and PDF.',
  'A critical failure (real or simulated) generates an alert by email and in at least one of Slack/Teams.',
  'Every chatbot response allows a like/dislike, previous sessions can be consulted, and latency is shown.',
  'The status panel reflects QA, Main, Payment health; where there is no source access, the surface is MOCK or WAITING_FOR_INTEGRATION, never LIVE.',
  'The UI stays smooth under a load test with massive log generation (thresholds to be defined with Urbani).',
  'The DPI 1 provenance model is preserved — no fabricated data or answers.',
]);
heading('2.3', 'Roles to implement (RBAC)', 2);
bullets([
  { label: 'Super Admin', text: 'full administration.' },
  { label: 'Infrastructure Administrator', text: 'manage infrastructure-facing configuration.' },
  { label: 'QA Operator', text: 'operate QA monitoring; limited configuration.' },
  { label: 'Reader / Auditor', text: 'read-only; cannot modify configuration (enforced server-side).' },
]);

// ---- 3. What we delivered in DPI 1 ------------------------------------------
heading('3.', 'What We Delivered in DPI 1 (Baseline)', 1);
table(
  ['Area', 'DPI 1 delivered state'],
  [
    ['Dashboard', 'React 18 + Vite SPA (nginx) + Node 20/Express API, single ECS Fargate task behind an ALB.'],
    ['Auth', 'JWT, bcrypt-hashed passwords, one seeded bootstrap admin. Single access level (no roles).'],
    ['Persistence', 'SQLite at /data/urbani.sqlite on a mounted volume. Single-writer -> one task only.'],
    ['Live logs', 'QA /logs/latest + /logs/history; upstream returns only flagged lines, so real lines are surfaced from alert evidence and merged into the Logs view.'],
    ['Live incidents', 'QA /alerts/latest + /alerts/history; evidence correlated to logs; confidence derived from severity and labelled "(derived)".'],
    ['AI Copilot', 'QA POST /chat (Bedrock Nova 2 Lite), grounded server-side. Advisory, read-only. No feedback, history, or latency metric.'],
    ['Metrics / Services', 'MOCK (QA exposes no endpoints), labelled honestly.'],
    ['Provenance', 'LIVE / MOCK / WAITING_FOR_INTEGRATION across every surface. No fabrication.'],
    ['Secrets', 'JWT secret + Urbani API key in AWS Secrets Manager via the deploy script.'],
    ['Incident pipeline (CDK)', 'EventBridge -> Collector -> Bedrock -> Alert Writer -> DynamoDB written as CDK with placeholder Lambdas; not deployed.'],
    ['Scope of services', 'QA only (main, payments under QA). Main/Payment as separate servers not wired.'],
  ],
  [0.24, 0.76],
);

// ---- 4. Gap analysis / backlog ----------------------------------------------
heading('4.', 'Gap Analysis — DPI 2 Backlog', 1);
para(
  'Each item below maps a DPI 2 backlog task to our DPI 1 baseline: where we are now, the concrete work, ' +
    'and whether it is blocked on a client input (detailed in Section 6). Effort figures are the scope ' +
    'document\u2019s estimates. P0 = essential, P1 = high, P2 = if capacity allows.',
);
table(
  ['#', 'Backlog item', 'Pri', 'Effort', 'Status now -> delta'],
  [
    ['1', 'Persistence SQLite -> DynamoDB (users/prefs, audit, chat, feedback)', 'P0', '5 h', 'No real DynamoDB adapter today. Build one behind the repository boundary; removes single-writer; enables 2+ tasks.'],
    ['2', 'RBAC: 4 roles across API + UI', 'P0', '6 h', 'Single access level today. Add role model, server-side authorization, UI gating, per-role test cases.'],
    ['3', 'SSO (SAML/OIDC, Google Workspace) + MFA', 'P1', '5 h', 'None today. Cognito federation + group -> role mapping; alternative: JWT + TOTP. IdP-gated.'],
    ['4', 'Audit logs for config + sensitive queries', 'P0', '4 h', 'Partial, SQLite/MOCK today. Persist user/action/timestamp to DynamoDB; expose in Audit view.'],
    ['5', 'Advanced filters + search (severity, server, dates, text/regex)', 'P0', '6 h', 'Window-only filtering today. Add API params + pagination + full-stream search via Logs Insights. Access-gated.'],
    ['6', 'Export logs/reports (CSV, JSON, PDF)', 'P1', '4 h', 'None today. Backend export endpoints; large files staged in S3 if needed.'],
    ['7', 'Automatic alerts: email + Slack + Teams', 'P1', '6 h', 'In-app only today. DynamoDB Streams -> Lambda Notifier -> SNS + webhooks; rules by severity/service; dedup. Webhook-gated.'],
    ['8', 'Chatbot feedback (like/dislike) + history', 'P1', '6 h', 'Stateless today. Persist sessions/messages per user; capture feedback; resume prior sessions.'],
    ['9', 'AI latency metric visible in chat', 'P1', '3 h', 'Not surfaced today. Measure end-to-end latency (incl. Urbani /chat), display per answer. Quick win.'],
    ['10', 'Health/uptime panel (QA, Main, Payment)', 'P1', '5 h', 'No panel today. CloudWatch Synthetics + Route 53 health checks; Container Insights. Access-gated.'],
    ['11', 'Corporate branding + dark mode', 'P1', '4 h', 'Generic theme today. Apply logo + palette; dark-mode toggle persisted per user. Asset-gated.'],
    ['12', 'Dashboard personalization (rearrangeable widgets)', 'P2', '4 h', 'Fixed layout today. Draggable widgets; per-user layout persisted in DynamoDB.'],
    ['13', 'Load tests for dashboard + API', 'P2', '4 h', 'None today. Distributed Load Testing on AWS / k6; extend the automated suite. Threshold-gated.'],
  ],
  [0.05, 0.3, 0.07, 0.08, 0.5],
);
para('Estimated total effort: ~64 h. Estimates and owners confirmed at kickoff.', { oblique: true, color: GREY });

// ---- 5. Upgrade roadmap -----------------------------------------------------
heading('5.', 'Consolidated Upgrade Roadmap', 1);
para('Ordered by dependency and priority. Items marked "gated" cannot reach LIVE without the matching client input in Section 6.');
bullets([
  { label: '1 (P0)', text: 'DynamoDB persistence — foundation for roles, audit, chat history, preferences, multi-task.' },
  { label: '2 (P0)', text: 'RBAC — 4 roles, API + UI.' },
  { label: '3 (P0)', text: 'Audit logging.' },
  { label: '4 (P0)', text: 'Advanced log filters + search (Logs Insights / regex) — access-gated.' },
  { label: '5 (P1)', text: 'SSO + MFA (Cognito/Google) or JWT+TOTP fallback — IdP-gated.' },
  { label: '6 (P1)', text: 'Alerts to email + Slack/Teams — webhook-gated.' },
  { label: '7 (P1)', text: 'Chat feedback + history.' },
  { label: '8 (P1)', text: 'AI latency metric — quick win, can start day 1.' },
  { label: '9 (P1)', text: 'Health/uptime panel QA/Main/Payment — access-gated.' },
  { label: '10 (P1)', text: 'Branding + dark mode — asset-gated.' },
  { label: '11 (P1)', text: 'Log/report export CSV/JSON/PDF.' },
  { label: '12 (P2)', text: 'Dashboard widget personalization.' },
  { label: '13 (P2)', text: 'Load tests + extended automated suite — threshold-gated.' },
]);
para(
  'New AWS services introduced in DPI 2: Cognito, DynamoDB (as the live store), DynamoDB Streams, Lambda ' +
    'Notifier, SNS, CloudWatch Synthetics, Route 53 health checks, Container Insights, S3 (export), and ' +
    'Distributed Load Testing / k6.',
);

// ---- 6. What we need FROM THE CLIENT ----------------------------------------
heading('6.', 'What We Need From Urbani', 1);
para(
  'These inputs unblock the backlog. "Hard" means work cannot start; "Soft" means we can start against a ' +
    'MOCK/placeholder and flip to LIVE later.',
);
heading('6.1', 'Access & identity (hard blockers)', 2);
bullets([
  { label: 'AWS account/region + permissions', text: 'to create DynamoDB, Cognito, SNS, Lambda, Synthetics, S3, IAM roles. Unblocks items 1,3,4,7,10,13.' },
  { label: 'Identity Provider admin access', text: 'Google Workspace (or chosen IdP) to configure SAML/OIDC + MFA, plus the group -> role mapping. Unblocks item 3 — or confirm the JWT+TOTP fallback.' },
  { label: 'Read access to Main and Payment', text: 'logs/metrics (plus where those services run and how to probe health) — or an explicit decision to treat them as MOCK. Unblocks items 5,10.' },
  { label: 'CloudWatch log-group names/ARNs', text: 'for QA/Main/Payment + permission to run Logs Insights — or agreement to extend the Urbani /logs API for full-stream search. Unblocks items 5,6.' },
]);
heading('6.2', 'Notification channels (hard blocker for alerts)', 2);
bullets([
  { label: 'Destination email address(es)', text: 'for SNS alert subscriptions.' },
  { label: 'Slack and/or Teams webhook URL', text: 'authorized by Urbani (stored in Secrets Manager).' },
  { label: 'Alert rules', text: 'which severities/services notify, and the deduplication window.' },
]);
heading('6.3', 'Branding & UX (soft — can theme generically first)', 2);
bullets([
  { label: 'Official Urbani logo', text: 'SVG + PNG for header/nav.' },
  { label: 'Corporate color palette', text: 'exact hex values (primary/secondary/dark-mode).' },
  { label: 'Dark-mode guidance', text: 'if different from a straight inversion.' },
]);
heading('6.4', 'Decisions & definitions', 2);
bullets([
  { label: 'RBAC permission matrix', text: 'exactly what each of the 4 roles may view and do (especially Reader/Auditor restrictions).' },
  { label: 'SSO vs JWT+TOTP', text: 'pick the authentication approach (affects the IdP dependency).' },
  { label: 'Audit scope', text: 'which actions/queries are "sensitive"; retention for audit, chat history, exports.' },
  { label: 'Load/performance thresholds (SLOs)', text: 'explicitly "to be defined with Urbani" (p95 latency, concurrent users, log rate).' },
  { label: 'Data privacy', text: 'confirmation that stored chat/exports are PII-free or de-identified; KMS encryption at rest assumed.' },
]);
heading('6.5', 'Security carried over from DPI 1 (close before go-live)', 2);
bullets([
  { label: 'Rotate the shared Urbani API key', text: 'and store the new value in Secrets Manager.' },
  { label: 'Replace the bootstrap admin password', text: 'with a strong secret in Secrets Manager (dev default currently in use).' },
]);
heading('6.6', 'Logistics / sponsorship', 2);
bullets([
  { label: 'Named Urbani sponsor', text: 'the scope doc leaves this to be confirmed.' },
  { label: 'Confirmed builders + dates + rooms', text: 'the doc assumes ~4 builders over 2 days.' },
  { label: 'Repository + IAM + Bedrock access', text: 'GitHub/CodeCommit access, builder IAM, Bedrock model access, AWS Budgets on.' },
]);

// ---- 7. Open questions ------------------------------------------------------
heading('7.', 'Open Questions to Resolve at Kickoff', 1);
bullets([
  { label: 'Full-stream log search', text: 'CloudWatch Logs Insights vs. extending the Urbani /logs API. Drives items 5, 6 and the Main/Payment access ask. Recommendation: Logs Insights if we get log-group access.' },
  { label: 'Auth path', text: 'Cognito+Google (full SSO/MFA, IdP-dependent) vs. JWT+TOTP (lighter, no IdP). Recommendation: Cognito if IdP access is granted in time; otherwise JWT+TOTP to still meet the MFA criterion.' },
  { label: 'DynamoDB data model', text: 'single-table vs per-entity for users/prefs/audit/chat/feedback. Decide at kickoff by access pattern.' },
  { label: 'Main/Payment reality', text: 'real reachable services for LIVE, or MOCK for DPI 2? Caps how much of items 5 and 10 can be LIVE.' },
  { label: 'Alerts channel minimum', text: 'the criterion requires email + at least one of Slack/Teams — confirm which messaging platform Urbani provides.' },
  { label: 'Starting-point honesty', text: 'align that DPI 2 is where DynamoDB persistence and the notifier pipeline are actually built.' },
]);

// ---- 8. Kickoff checklist ---------------------------------------------------
heading('8.', 'DPI 2 Kickoff Checklist (one page for the sponsor)', 1);
bullets([
  'AWS account + region + builder IAM confirmed; Bedrock access + Budgets on.',
  'Decision: Cognito+Google SSO or JWT+TOTP. If Cognito: Google Workspace admin access + group -> role map provided.',
  'Decision: Logs Insights access (log-group ARNs for QA/Main/Payment) or Urbani /logs API extension.',
  'Main/Payment: LIVE access granted, or agreed as MOCK for DPI 2.',
  'Notification: alert email(s) + Slack/Teams webhook(s) + severity rules + dedup window.',
  'Branding: logo (SVG/PNG) + palette hex + dark-mode guidance.',
  'RBAC permission matrix signed off; audit "sensitive action" list + retention defined.',
  'Load-test thresholds/SLOs agreed.',
  'Data confirmed PII-free/de-identified; KMS encryption expectations confirmed.',
  'DPI 1 carry-overs scheduled: rotate API key, replace bootstrap admin password.',
  'Sponsor named; builders + dates + rooms/collab tools + repo confirmed.',
]);
para(
  'Prepared from the two client documents (DPI2_Urbani_UrbiNexus_EN.docx and Upgrades_UrbiNexus_DPI_EN.pdf) ' +
    'and the delivered DPI 1 codebase. Effort estimates, owners, and the final architecture (Cognito, ' +
    'DynamoDB, SNS/Slack/Teams, Synthetics) are per the DPI 2 scope and will be confirmed with Urbani at ' +
    'kickoff; ingestion from Main and Payment depends on source access.',
  { oblique: true, color: GREY },
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
  const rowH = isTop ? 20 : 16;
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
    .text('Urbani Radar UrbiNexus — DPI 2 Plan', M, FOOT_Y, { width: CONTENT_W / 2, align: 'left', lineBreak: false });
  doc.text(`Page ${printed} of ${range.count}`, M + CONTENT_W / 2, FOOT_Y, { width: CONTENT_W / 2, align: 'right', lineBreak: false });
}

doc.end();
console.log(`DPI 2 plan PDF generated at: ${OUT_FILE}`);
console.log(`Total pages: ${range.count}`);
console.log(`TOC entries: ${toc.length}`);
