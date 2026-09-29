/* Generates OUTPUT/Urbani_AWS_Architecture_Proposal.docx reflecting the current
 * plan: custom web dashboard (no Grafana/CloudWatch dashboards), AI log chatbot,
 * live logs API + LIVE/MOCK provenance, CDK IaC, phase status. Embeds the new
 * AWS-icon architecture diagram PNG. */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, ImageRun, BorderStyle, ShadingType,
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

function kvTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([k, v], i) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: 32, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, fill: i === 0 ? GOLD : 'F3F4F6' },
            children: [new Paragraph({ children: [new TextRun({ text: k, bold: true, size: 20, color: i === 0 ? 'FFFFFF' : DARK })] })],
          }),
          new TableCell({
            width: { size: 68, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, fill: i === 0 ? GOLD : 'FFFFFF' },
            children: [new Paragraph({ children: [new TextRun({ text: v, size: 20, color: i === 0 ? 'FFFFFF' : DARK })] })],
          }),
        ],
      }),
    ),
  });
}

const diagram = () => {
  const img = fs.readFileSync(path.join(OUT, 'Urbani_AWS_Architecture_Diagram.png'));
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
    children: [new ImageRun({ data: img, transformation: { width: 620, height: 366 } })],
  });
};

const children = [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new TextRun({ text: 'URBANI', bold: true, size: 48, color: GOLD })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: 'Proactive Observability & AI Troubleshooting Assistant', bold: true, size: 30, color: DARK })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: 'AWS Architecture Proposal — v3.0 (Custom Dashboard + AI Log Chatbot)', size: 22, color: GREY, italics: true })] }),

  H('1. Document Control', HeadingLevel.HEADING_1),
  kvTable([
    ['Field', 'Value'],
    ['Project', 'Urbani Proactive Observability & AI Troubleshooting Assistant'],
    ['Client', 'Urbani — Engineering & Operations Team'],
    ['Document Version', '3.0 (Custom Web Dashboard, AI Log Chatbot, Live Logs API, CDK IaC)'],
    ['Delivery', 'Custom web application + AWS CDK infrastructure'],
    ['Status', 'Updated proposal reflecting implemented Phase 1/2 + live log integration'],
    ['Confidentiality', 'Internal & Urbani — Confidential'],
  ]),

  H('2. Executive Summary', HeadingLevel.HEADING_1),
  P('Urbani operates cloud applications on AWS Elastic Beanstalk. For over two years the team has relied on manual CloudWatch queries to detect and resolve incidents, causing operational toil and knowledge loss. This solution introduces an AI-assisted, proactive observability platform: telemetry is collected on a fixed schedule, analyzed by Amazon Bedrock for anomalies, persisted as evidence-based alerts, and surfaced through a custom web dashboard with an AI log chatbot.'),
  P('Key delivery decision: the visualization layer is a purpose-built custom web dashboard (React SPA + Node API) — not Amazon Managed Grafana and not CloudWatch dashboards. This gives Urbani full control over UX, an integrated AI log chatbot, and a clean provenance model (LIVE / MOCK / WAITING) so users always know whether data is real telemetry or placeholder.', { bold: true }),

  H('3. What Has Been Delivered', HeadingLevel.HEADING_1),
  bullet('Custom web dashboard (React + Node, containerized behind an nginx reverse proxy) — Dashboard, Alerts, Logs, Metrics, AI Insights, Services, Usage & Cost, Audit, Settings.'),
  bullet('AI Log Chatbot — engineers ask natural-language questions about the logs; answers are grounded in the current log window, cite specific log lines, and are advisory only.'),
  bullet('Live log integration — real Urbani CloudWatch logs are already consumed via an API Gateway endpoint (x-api-key), surfaced with a LIVE provenance label.'),
  bullet('Adapter architecture — CloudWatch / Bedrock / DynamoDB / Urbani-application integrations sit behind interfaces; unavailable sources show MOCK/WAITING until provisioned.'),
  bullet('AWS CDK infrastructure (TypeScript) — synth-ready stack for the full pipeline (not auto-deployed).'),
  bullet('Production hardening — single environment-config model, Dockerized stack, health/readiness probes, security headers, rate limiting, and a professional light UI (brand #D1990A).'),

  H('4. Target Architecture', HeadingLevel.HEADING_1),
  P('Elastic Beanstalk → CloudWatch Logs & Metrics → EventBridge Scheduler (5 min) → Lambda Collector → Amazon Bedrock + Guardrails → Lambda Alert Writer → DynamoDB → Custom Web Dashboard + AI Log Chatbot → Urbani Engineering Team.'),
  diagram(),
  P('Figure 1 — Target AWS architecture. Visualization is a custom web dashboard with an AI log chatbot (no Grafana / no CloudWatch dashboards).', { italics: true, color: GREY, size: 18 }),

  H('5. AI Design & Safeguards', HeadingLevel.HEADING_1),
  kvTable([
    ['Aspect', 'Specification'],
    ['Primary model', 'Anthropic Claude 3.5 Sonnet v2 (anthropic.claude-3-5-sonnet-20241022-v2:0)'],
    ['Fallback model', 'Amazon Nova Pro / Nova Lite (cost-optimized)'],
    ['Inference', 'temperature 0.0 · max_tokens 1024 · top_p 1.0 (deterministic)'],
    ['Guardrails', 'urbani-dpi-guardrail-v1 — PII redaction, prompt-injection defense'],
    ['Grounding rule', 'No log evidence → NO_ANOMALY_DETECTED; chatbot refuses to speculate'],
    ['Model configuration', 'Config-driven (never hardcoded); confirmed at AWS enablement'],
  ]),
  P('The dashboard and chatbot are provider-agnostic: they consume an AIProvider contract. Phase 1 uses a deterministic mock provider; enabling Amazon Bedrock requires no UI or business-logic changes.'),

  H('6. AI Log Chatbot', HeadingLevel.HEADING_1),
  P('The chatbot lets engineers ask questions such as “are there any errors right now?”, “summarize the current logs”, or “what should I investigate next?”. It pulls the current log window through the same adapter boundary as the dashboard (LIVE when the real API is connected), grounds its answer in that evidence, cites the specific log lines used, and never performs any automated action. This directly addresses the two-year problem of manual, repetitive log triage.'),

  H('7. Data & Persistence', HeadingLevel.HEADING_1),
  kvTable([
    ['Component', 'Detail'],
    ['DynamoDB table', 'UrbaniAlerts — PK service_id, SK timestamp'],
    ['GSI', 'anomaly_type-index'],
    ['Alert contract', 'UrbaniIncidentAlert (alertId, severity, evidence[], probableCause, recommendedActions[], confidence, modelId, …)'],
    ['Encryption', 'KMS customer-managed key, at rest'],
  ]),

  H('8. Security & Governance', HeadingLevel.HEADING_1),
  bullet('Read-only MVP — zero write access to production application runtimes; no automated remediation.'),
  bullet('Least-privilege IAM (UrbaniCollectorExecutionRole): read-only CloudWatch + bedrock:InvokeModel only.'),
  bullet('KMS encryption at rest; CloudTrail auditing of Bedrock / Lambda / DynamoDB calls.'),
  bullet('AWS Budgets soft/hard alerts ($50 / $100) — cost control after prior $5–6k spikes.'),
  bullet('No secrets in source, logs, or the browser bundle; API keys injected via environment only.'),

  H('9. Infrastructure as Code (AWS CDK)', HeadingLevel.HEADING_1),
  P('All AWS resources are defined as an AWS CDK app (TypeScript) — SecurityConstruct (KMS, CloudTrail, IAM), PersistenceConstruct (DynamoDB), OrchestrationConstruct (EventBridge + Lambdas), CostConstruct (Budgets), and DashboardConstruct (custom dashboard hosting boundary). The stack is synth-ready and validated; it is not deployed until AWS credentials, model access, and a least-privilege review are confirmed.'),

  H('10. Delivery Phases', HeadingLevel.HEADING_1),
  kvTable([
    ['Phase', 'Status'],
    ['Phase 1 — App foundation + custom Admin Dashboard (mock adapters)', 'DONE'],
    ['Phase 2 — Production hardening, Dockerization, light UI redesign', 'DONE'],
    ['Phase 3 — Live logs API integration + AI Log Chatbot', 'DONE (logs LIVE; metrics/services/alerts MOCK until endpoints provisioned)'],
    ['Phase 4 — Bedrock model enablement (real AI analysis + chatbot answers)', 'READY — flip provider behind AIProvider'],
    ['Phase 5 — Full AWS deploy via CDK (Lambdas, EventBridge, DynamoDB)', 'READY — synth validated, awaiting AWS access'],
  ]),

  H('11. Open Items / Awaiting Client', HeadingLevel.HEADING_1),
  bullet('Metrics and services API endpoints (currently 403 for the provided key) — needed to move those areas from MOCK to LIVE.'),
  bullet('Confirmed Amazon Bedrock model access + guardrail provisioning to enable real AI analysis and chatbot answers.'),
  bullet('AWS account/region + IAM permissions to deploy the CDK stack.'),
  bullet('The current logs window is often empty; real log activity (or a historical endpoint) is required to demonstrate populated data.'),
];

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Calibri', color: DARK } } },
  },
  sections: [{ properties: {}, children }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(path.join(OUT, 'Urbani_AWS_Architecture_Proposal.docx'), buf);
  console.log('Wrote Urbani_AWS_Architecture_Proposal.docx (' + buf.length + ' bytes)');
});
