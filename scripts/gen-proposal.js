/* Generates OUTPUT/Urbani_AWS_Architecture_Proposal.docx as a forward-looking
 * PROPOSAL: custom web dashboard (no Grafana/CloudWatch dashboards), AI log
 * chatbot, live logs API, CDK IaC. All language is proposed/planned tense — no
 * claims of work already delivered. Embeds the AWS-icon architecture diagram. */
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
    children: [new ImageRun({ data: img, type: 'png', transformation: { width: 620, height: 360 } })],
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
    ['Scope', 'Proposed custom web application + AWS CDK infrastructure'],
    ['Status', 'Proposal for review — scope, architecture, and delivery plan'],
    ['Confidentiality', 'Internal & Urbani — Confidential'],
  ]),

  H('2. Executive Summary', HeadingLevel.HEADING_1),
  P('Urbani operates cloud applications on AWS Elastic Beanstalk. For over two years the team has relied on manual CloudWatch queries to detect and resolve incidents, causing operational toil and knowledge loss. This document proposes an AI-assisted, proactive observability platform: telemetry would be collected on a fixed schedule, analyzed by Amazon Bedrock for anomalies, persisted as evidence-based alerts, and surfaced through a custom web dashboard with an AI log chatbot.'),
  P('Key design decision: the visualization layer is proposed as a purpose-built custom web dashboard (React SPA + Node API) — not Amazon Managed Grafana and not CloudWatch dashboards. This would give Urbani full control over UX, an integrated AI log chatbot, and a clear data-provenance model so users always know whether a value is real telemetry or a placeholder.', { bold: true }),

  H('3. Proposed Scope', HeadingLevel.HEADING_1),
  bullet('Custom web dashboard (React + Node, containerized behind an nginx reverse proxy) — Dashboard, Alerts, Logs, Metrics, AI Insights, Services, Usage & Cost, Audit, Settings.'),
  bullet('AI Log Chatbot — engineers ask natural-language questions about the logs; answers would be grounded in the current log window, cite specific log lines, and remain advisory only.'),
  bullet('Live log integration — Urbani CloudWatch logs consumed via an API Gateway endpoint (x-api-key), surfaced with a clear data-provenance label.'),
  bullet('Adapter architecture — CloudWatch / Bedrock / DynamoDB / Urbani-application integrations sit behind interfaces so each source can be enabled independently as it is provisioned.'),
  bullet('AWS CDK infrastructure (TypeScript) — a single stack defining the full pipeline, to be deployed once AWS access is granted.'),
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
  P('The dashboard and chatbot are designed to be provider-agnostic: they consume an AIProvider contract. A deterministic mock provider would be used during development; enabling Amazon Bedrock would require no UI or business-logic changes.'),

  H('6. AI Log Chatbot', HeadingLevel.HEADING_1),
  P('The chatbot would let engineers ask questions such as “are there any errors right now?”, “summarize the current logs”, or “what should I investigate next?”. It would pull the current log window through the same adapter boundary as the dashboard, ground its answer in that evidence, cite the specific log lines used, and never perform any automated action. This directly addresses the two-year problem of manual, repetitive log triage. No vector database or RAG index is required for this scope: the chatbot grounds answers in the current, bounded log window queried directly. A Bedrock Knowledge Base could be added later as future scope if semantic search over long log history or runbooks becomes a requirement.'),

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
  P('All AWS resources would be defined as an AWS CDK app (TypeScript) — SecurityConstruct (KMS, CloudTrail, IAM), PersistenceConstruct (DynamoDB), OrchestrationConstruct (EventBridge + Lambdas), CostConstruct (Budgets), and DashboardConstruct (custom dashboard hosting boundary). The stack would be deployed once AWS credentials, model access, and a least-privilege review are confirmed.'),

  H('10. Proposed Delivery Phases', HeadingLevel.HEADING_1),
  kvTable([
    ['Phase', 'Scope'],
    ['Phase 1 — App foundation + custom Admin Dashboard', 'Build the dashboard shell and all pages against adapter interfaces.'],
    ['Phase 2 — Production hardening, Dockerization, light UI', 'Containerize the stack, add health probes, security headers, rate limiting, light UI.'],
    ['Phase 3 — Live logs API integration + AI Log Chatbot', 'Wire Urbani logs via API Gateway; build the grounded, advisory chatbot.'],
    ['Phase 4 — Bedrock model enablement', 'Enable Claude 3.5 Sonnet v2 + guardrail behind the AIProvider contract.'],
    ['Phase 5 — Full AWS deploy via CDK', 'Deploy Lambdas, EventBridge, DynamoDB, and governance via the CDK stack.'],
  ]),

  H('11. Prerequisites from Client / AWS', HeadingLevel.HEADING_1),
  bullet('Metrics and services API endpoints — needed to surface those areas as live data.'),
  bullet('Amazon Bedrock model access + guardrail provisioning to enable AI analysis and chatbot answers.'),
  bullet('AWS account/region + IAM permissions to deploy the CDK stack.'),
  bullet('Access to real log activity (or a historical logs endpoint) to demonstrate populated data.'),
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
