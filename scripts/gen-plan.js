/* Generates OUTPUT/Urbani_DPI_Implementation_Plan.docx — updated execution plan
 * reflecting the delivered custom dashboard, chatbot, live logs, and CDK. */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, ShadingType,
} = require('docx');

const OUT = path.join(__dirname, '..', 'OUTPUT');
const GOLD = 'D1990A';
const DARK = '172033';
const GREY = '667085';

const H = (text, level) => new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
const P = (text, opts = {}) =>
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, color: opts.color || DARK, bold: !!opts.bold, italics: !!opts.italics, size: opts.size || 22 })] });
const bullet = (text) =>
  new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text, size: 22, color: DARK })] });

function table(header, rows) {
  const mk = (cells, head) =>
    new TableRow({
      children: cells.map((c) =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: head ? GOLD : 'FFFFFF' },
          children: [new Paragraph({ children: [new TextRun({ text: c, bold: head, size: 18, color: head ? 'FFFFFF' : DARK })] })],
        }),
      ),
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [mk(header, true), ...rows.map((r) => mk(r, false))],
  });
}

const children = [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new TextRun({ text: 'URBANI — Implementation & Execution Plan', bold: true, size: 34, color: GOLD })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: 'Custom Web Dashboard + AI Log Chatbot · Live Logs · AWS CDK', size: 22, color: GREY, italics: true })] }),

  H('1. Purpose', HeadingLevel.HEADING_1),
  P('This plan records the delivered implementation and the remaining path to full AWS enablement. The scope has been refined since the original DPI plan: the visualization layer is a custom web dashboard (not Grafana/CloudWatch dashboards) and now includes an AI log chatbot; real Urbani logs are already integrated.'),

  H('2. Definition of Done — Status', HeadingLevel.HEADING_1),
  table(
    ['Criterion', 'Status'],
    [
      ['Ingest logs/metrics from Elastic Beanstalk via CloudWatch', 'LIVE for logs (API Gateway); metrics pending endpoint'],
      ['AI anomaly detection + structured recommendation', 'Implemented via AIProvider (mock now, Bedrock-ready)'],
      ['Persist alerts to DynamoDB UrbaniAlerts', 'Modeled in CDK + app repository (mock store in dev)'],
      ['Unified visualization dashboard', 'DONE — custom web dashboard'],
      ['AI log chatbot for natural-language triage', 'DONE — grounded, advisory'],
    ],
  ),

  H('3. Workstreams', HeadingLevel.HEADING_1),
  bullet('WS1 — Custom Web Dashboard (React + Node, containerized, light UI, brand #D1990A). DONE.'),
  bullet('WS2 — AI Log Chatbot (AIProvider.askLogs, /api/chat, chat UI). DONE.'),
  bullet('WS3 — Telemetry Ingestion (live logs via API Gateway; adapter boundary). DONE for logs.'),
  bullet('WS4 — AI Analysis Engine (Bedrock + Guardrails, config-driven). READY for enablement.'),
  bullet('WS5 — Persistence (DynamoDB UrbaniAlerts) via CDK. Synth-validated.'),
  bullet('WS6 — Infrastructure as Code (AWS CDK, TypeScript). Synth-validated, not deployed.'),
  bullet('WS7 — Security & Cost governance (IAM least-priv, KMS, CloudTrail, Budgets). Modeled in CDK.'),

  H('4. Task Backlog & Status', HeadingLevel.HEADING_1),
  table(
    ['ID', 'Task', 'Status'],
    [
      ['T01', 'Custom Admin Dashboard shell + all pages', 'DONE'],
      ['T02', 'Production hardening + Dockerization + light UI', 'DONE'],
      ['T03', 'Live logs API integration (LIVE provenance)', 'DONE'],
      ['T04', 'AI Log Chatbot (backend + frontend)', 'DONE'],
      ['T05', 'AWS CDK infrastructure scaffold (synth-ready)', 'DONE'],
      ['T06', 'Enable Amazon Bedrock model + guardrail', 'WAITING — AWS access'],
      ['T07', 'Provision metrics/services API endpoints', 'WAITING — client'],
      ['T08', 'Deploy CDK stack to AWS account', 'WAITING — AWS access'],
      ['T09', 'End-to-end anomaly demo with real data', 'WAITING — log activity/history'],
    ],
  ),

  H('5. Demonstration Scenario', HeadingLevel.HEADING_1),
  P('1) An engineer opens the custom dashboard and reviews KPIs, alerts, and the live log stream. 2) They open the AI Log Assistant and ask “are there any errors right now?”. 3) The assistant answers from the current log window, citing specific log lines, and suggests what to investigate — advisory only. 4) When Bedrock is enabled, the same flow is answered by Claude 3.5 Sonnet v2 with no UI change.'),

  H('6. Evaluation Criteria', HeadingLevel.HEADING_1),
  bullet('Provenance clarity — every value is labelled LIVE, MOCK, or WAITING.'),
  bullet('Evidence grounding — AI answers cite real log lines; empty window → honest “no evidence”.'),
  bullet('Cost control — bounded windows, 5-min cadence, Budgets alerts.'),
  bullet('Security — read-only, least-privilege, no secrets exposed, human-in-the-loop.'),

  H('7. Next Steps', HeadingLevel.HEADING_1),
  bullet('Grant Amazon Bedrock model access + provision urbani-dpi-guardrail-v1.'),
  bullet('Provide metrics/services API endpoints (or history for logs) to expand LIVE coverage.'),
  bullet('Supply AWS account/region + IAM permissions to deploy the CDK stack.'),
  bullet('Rotate the shared logs API key and store it in a secret manager.'),
];

const doc = new Document({
  styles: { default: { document: { run: { font: 'Calibri', color: DARK } } } },
  sections: [{ properties: {}, children }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(path.join(OUT, 'Urbani_DPI_Implementation_Plan.docx'), buf);
  console.log('Wrote Urbani_DPI_Implementation_Plan.docx (' + buf.length + ' bytes)');
});
