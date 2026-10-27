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
  rows.forEach((r, i) => drawRow(r, { fill: i % 2 ? LIGHT : WHITE }));
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
    'This document describes the delivered Urbani observability dashboard: its architecture, features, ' +
      'live AWS data integration (CloudWatch logs, AI-generated incidents, and the Amazon Bedrock-powered ' +
      'Copilot), the security and data-provenance model, and the ECS Fargate deployment. All content ' +
      'reflects the implemented system.',
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
  'The Urbani Proactive Observability & AI Troubleshooting Assistant is a custom web dashboard that gives ' +
    'operations teams a single, honest view of their QA service health. It surfaces live logs and ' +
    'AI-generated incident alerts from the Urbani QA environment and provides an in-context AI assistant ' +
    '(the "Urbani Copilot") that answers questions grounded in the real log and incident evidence. It is ' +
    'advisory and human-in-the-loop: the system never performs automated remediation.',
);
para('The delivered system includes:');
bullets([
  { label: 'Dashboard & alerts', text: 'health summary, alerts/incidents list and detail, logs, metrics, services, usage/cost, audit, and settings views.' },
  { label: 'Live AWS data', text: 'real logs and AI-generated incidents from the Urbani QA API Gateway, with the Copilot answering via Amazon Bedrock (Nova 2 Lite) server-side.' },
  { label: 'Honest provenance', text: 'every data surface is labelled LIVE, MOCK, or WAITING_FOR_INTEGRATION so viewers always know the source of what they see.' },
  { label: 'Production deployment', text: 'containerized frontend and backend running as a single ECS Fargate task behind an Application Load Balancer with TLS, served at a dedicated domain.' },
]);

// ---- 2. System Architecture -------------------------------------------------
heading('2.', 'System Architecture', 1);
para(
  'The application is a TypeScript monorepo with three packages — a shared types library, an Express ' +
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
    ['Backend', 'Node.js 20 + Express', 'REST API, JWT auth, live-data adapters, persistence (port 4000).'],
    ['Shared', 'TypeScript library', 'Common contracts and types used by both backend and frontend.'],
    ['Persistence', 'SQLite (better-sqlite3)', 'Stores users, alerts, telemetry, and audit; a single file on a mounted volume.'],
    ['Incident pipeline', 'AWS CDK (EventBridge, Lambda, Bedrock, DynamoDB)', 'Serverless pipeline that generates incidents upstream (infrastructure-as-code).'],
  ],
  [0.22, 0.28, 0.5],
);

// ---- 3. Application Features ------------------------------------------------
heading('3.', 'Application Features', 1);
heading('3.1', 'Dashboard & navigation', 2);
bullets([
  { label: 'Dashboard', text: 'at-a-glance service health summary and status.' },
  { label: 'Alerts / Incidents', text: 'list and detail of AI-generated incidents with severity, anomaly type, confidence, evidence, and recommended actions.' },
  { label: 'Logs', text: 'live log viewer with level/service/text filtering, merged from the live window and recent incident evidence.' },
  { label: 'Metrics, Services, Usage & Cost, Audit, Settings', text: 'supporting operational views, each with an honest source label.' },
]);
heading('3.2', 'Urbani Copilot (AI assistant)', 2);
para(
  'The Copilot answers operational questions ("Are there any errors right now?", "Summarize the current ' +
    'logs") grounded in the real log window and incident evidence. In live mode the question is sent to the ' +
    'Urbani QA chat endpoint, which grounds the answer server-side on Amazon Bedrock (Nova 2 Lite) across ' +
    'recent log windows and alerts, and returns the model answer. The assistant is advisory only and never ' +
    'takes action.',
);
callout(
  'Chat vs. Logs scope',
  'The Copilot is grounded server-side across both recent logs and incident alerts, so it may describe an ' +
    'incident that the currently-filtered log window does not list. The assistant surfaces a short grounding ' +
    'note making this scope explicit, so the two views are never mistaken for contradicting each other.',
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
    ['Logs', 'GET /logs/latest + /logs/history per service', 'Live log lines, merged latest + history, de-duplicated, newest-first, filterable.'],
    ['Incidents', 'GET /alerts/latest + /alerts/history', 'AI-generated incidents; their evidence lines are correlated back to the Logs view.'],
    ['Chat', 'POST /chat (Amazon Bedrock Nova 2 Lite)', 'Server-side grounded answer across recent logs + alerts; raw lines never cross the wire.'],
    ['Metrics / Services', 'Not provisioned upstream', 'Served as clearly-labelled MOCK (never claimed LIVE).'],
  ],
  [0.2, 0.4, 0.4],
);
heading('4.1', 'Log evidence correlation', 2);
para(
  'The upstream /logs endpoints currently return only "relevant" (flagged) lines, so the real log content ' +
    'arrives inside each incident\'s evidence. The backend parses that evidence — preserving original ' +
    'timestamps, inferring levels, and keeping message text verbatim — and surfaces it on the Logs view and ' +
    'in each alert\'s detail. This keeps the Logs view populated with genuine upstream data and gives every ' +
    'incident verifiable backing evidence. Nothing is ever fabricated.',
);
heading('4.2', 'Incident confidence', 2);
para(
  'The upstream incident source does not report a model confidence score. Rather than show an empty value, ' +
    'the system derives a confidence from incident severity and labels it clearly as "(derived)" in the UI, ' +
    'with an explanatory tooltip, so it is never mistaken for a model-reported score.',
);

// ---- 5. Security & Data Provenance -----------------------------------------
heading('5.', 'Security & Data Provenance', 1);
heading('5.1', 'Authentication', 2);
bullets([
  { label: 'JWT auth', text: 'all API routes except health and login require a signed JWT; passwords are bcrypt-hashed.' },
  { label: 'Secrets', text: 'the JWT signing secret and the Urbani API key are injected from AWS Secrets Manager at deploy time, never baked into images or source.' },
  { label: 'Server-side API key', text: 'the Urbani x-api-key is used only server-side; it is never logged, returned in responses, or sent to the browser.' },
]);
heading('5.2', 'Honest provenance model', 2);
para('Every data surface carries a source badge so viewers always know what they are looking at:');
table(
  ['Label', 'Meaning'],
  [
    ['LIVE', 'Real data fetched from the Urbani QA environment.'],
    ['MOCK', 'Deterministic sample data for a capability not yet provisioned upstream (e.g. metrics).'],
    ['WAITING_FOR_INTEGRATION', 'A live source is configured but temporarily unavailable (e.g. an upstream fetch failed) — shown instead of a silent empty state.'],
  ],
  [0.34, 0.66],
);
callout(
  'No fabrication',
  'The system never invents log lines or AI answers. When a live window is genuinely empty it says so; when ' +
    'an upstream call fails it degrades to an honest "temporarily unavailable" state. This honesty guarantee ' +
    'is enforced throughout the codebase.',
);

// ---- 6. Deployment ----------------------------------------------------------
heading('6.', 'Deployment — AWS ECS Fargate', 1);
para(
  'The application is deployed to ECS Fargate as a single task running two containers (frontend + backend) ' +
    'behind an Application Load Balancer, with TLS terminated at the ALB and the dashboard served at a ' +
    'dedicated domain. Both container images build from the repository root and are pushed to ECR.',
);
heading('6.1', 'Runtime topology', 2);
table(
  ['Setting', 'Value'],
  [
    ['Platform', 'AWS ECS Fargate (serverless containers), awsvpc networking'],
    ['Task size', '0.5 vCPU / 1 GB (512 CPU / 1024 MiB), desired count 1'],
    ['Frontend container', 'nginx + React SPA, port 8080 (ALB target)'],
    ['Backend container', 'Node/Express, port 4000, reached at 127.0.0.1:4000 within the task'],
    ['Load balancer', 'Application Load Balancer, HTTPS :443 (ACM cert), HTTP to HTTPS redirect'],
    ['Persistence', 'SQLite at /data/urbani.sqlite on a mounted volume (single-writer; one task)'],
    ['Secrets', 'JWT secret and Urbani API key from AWS Secrets Manager'],
    ['Logs', 'CloudWatch Logs with per-container stream prefixes; 30-day retention'],
  ],
  [0.26, 0.74],
);
heading('6.2', 'Deploy sequence', 2);
bullets([
  'Create ECR repositories and build + push the backend and frontend images from the repo root.',
  'Register the ECS task definition (two containers, secrets wired, health checks, awslogs).',
  'Create/attach the ALB target group and listener rules (HTTPS forward + HTTP to HTTPS redirect).',
  'Create or update the ECS service with deployment circuit-breaker and automatic rollback.',
  'Point the domain at the ALB via a Route 53 alias record.',
]);
heading('6.3', 'Health checks', 2);
bullets([
  { label: 'GET /health', text: 'liveness — always 200 when the process is up (used by the container and ALB health check).' },
  { label: 'GET /ready', text: 'readiness — verifies the database is reachable; returns 503 if not.' },
  { label: 'Frontend /healthz', text: 'nginx liveness target for the container health check.' },
]);

// ---- 7. Operations ----------------------------------------------------------
heading('7.', 'Operations & Maintenance', 1);
bullets([
  { label: 'Zero-downtime deploys', text: 'the ECS service uses a deployment circuit breaker with rollback and keeps 100% healthy capacity during deploys, so a bad image rolls back automatically.' },
  { label: 'Observability', text: 'container logs stream to CloudWatch with separate frontend/backend prefixes; the backend emits structured JSON logs.' },
  { label: 'Configuration', text: 'all behaviour is environment-driven; switching between mock and live data is a single INTEGRATION_MODE setting with no code change.' },
  { label: 'Data persistence', text: 'the SQLite file persists on its mounted volume across task replacement; the service runs a single task because SQLite is single-writer.' },
]);
callout(
  'Security action before go-live',
  'The bootstrap admin password and the Urbani API key must be set to strong values in AWS Secrets Manager ' +
    '(not the development defaults), and the previously shared API key should be rotated. The JWT secret is ' +
    'already generated and stored in Secrets Manager by the deployment script.',
);

// ---- 8. Quality & Testing ---------------------------------------------------
heading('8.', 'Quality & Testing', 1);
para(
  'The backend is covered by an automated test suite (unit and adapter-level) that runs as part of the ' +
    'build. Coverage includes the live log/alert adapters, log-evidence parsing and correlation, derived ' +
    'confidence, the degraded-vs-empty data distinction, authentication, and the chat grounding flow. The ' +
    'full build compiles the shared, backend, and frontend packages cleanly, and the frontend passes a ' +
    'strict TypeScript type check.',
);
bullets([
  { label: 'Automated tests', text: 'backend suite covering adapters, services, and auth, run on every build.' },
  { label: 'Type safety', text: 'end-to-end TypeScript with a strict frontend type check.' },
  { label: 'Honest-data tests', text: 'specific tests assert that empty or absent upstream data never produces fabricated output.' },
]);

// ---- 9. Roadmap -------------------------------------------------------------
heading('9.', 'Roadmap & Next Steps', 1);
para('Natural extensions beyond the delivered system, each fitting the existing architecture without rework:');
bullets([
  { label: 'DynamoDB persistence', text: 'move from single-task SQLite to the already-provisioned DynamoDB table to allow horizontal scaling.' },
  { label: 'Native Bedrock analyze', text: 'wire the full in-app Bedrock pipeline for on-demand analysis behind the existing provider interface.' },
  { label: 'Live metrics & services', text: 'promote metrics and services from MOCK to LIVE once those endpoints are provisioned upstream.' },
  { label: 'High availability', text: 'raise the task count across two AZs once persistence supports concurrent writers.' },
]);

// ---- 10. Glossary -----------------------------------------------------------
heading('10.', 'Glossary', 1);
table(
  ['Term', 'Definition'],
  [
    ['ALB', 'Application Load Balancer — the public entry point that terminates TLS and routes to the service.'],
    ['ECS Fargate', 'Serverless container runtime; no servers to manage, capacity set as task CPU/memory.'],
    ['Provenance badge', 'The LIVE / MOCK / WAITING_FOR_INTEGRATION label shown on every data surface.'],
    ['Copilot', 'The in-app AI assistant that answers questions grounded in live logs and incidents.'],
    ['Incident evidence', 'The real log lines attached to an AI-generated incident, used as backing proof.'],
    ['Nova 2 Lite', 'The Amazon Bedrock model used to generate incident analysis and Copilot answers.'],
  ],
  [0.24, 0.76],
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
