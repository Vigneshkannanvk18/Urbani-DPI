/* Generates OUTPUT/Urbani_AWS_Architecture_v3.pptx — updated executive deck. */
const fs = require('fs');
const path = require('path');
const PptxGenJS = require('pptxgenjs');

const OUT = path.join(__dirname, '..', 'OUTPUT');
const GOLD = 'D1990A';
const DARK = '172033';
const GREY = '667085';
const BG = 'F7F8FA';

const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
pptx.layout = 'WIDE';

function titleBar(slide, text) {
  slide.background = { color: 'FFFFFF' };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.12, fill: { color: GOLD } });
  slide.addText(text, { x: 0.5, y: 0.35, w: 12.3, h: 0.7, fontSize: 26, bold: true, color: DARK, fontFace: 'Calibri' });
}

// --- Slide 1: Title ---
let s = pptx.addSlide();
s.background = { color: BG };
s.addShape(pptx.ShapeType.rect, { x: 0, y: 3.0, w: 13.333, h: 0.08, fill: { color: GOLD } });
s.addText('URBANI', { x: 0.5, y: 1.9, w: 12.3, h: 0.9, fontSize: 54, bold: true, color: GOLD, align: 'center', fontFace: 'Calibri' });
s.addText('Proactive Observability & AI Troubleshooting Assistant', { x: 0.5, y: 3.15, w: 12.3, h: 0.6, fontSize: 24, color: DARK, align: 'center' });
s.addText('Custom Web Dashboard  ·  AI Log Chatbot  ·  Live Logs  ·  AWS CDK  —  v3.0', { x: 0.5, y: 3.9, w: 12.3, h: 0.5, fontSize: 15, color: GREY, italic: true, align: 'center' });

// --- Slide 2: What we deliver ---
s = pptx.addSlide();
titleBar(s, 'What We Deliver');
const deliver = [
  'Custom web dashboard (React + Node) — NOT Grafana / NOT CloudWatch dashboards',
  'AI Log Chatbot — ask questions about logs in natural language, evidence-grounded',
  'Live Urbani log integration via API Gateway (LIVE provenance labels)',
  'Amazon Bedrock analysis (Claude 3.5 Sonnet v2) behind a provider abstraction',
  'DynamoDB alert persistence · KMS · CloudTrail · IAM least-privilege · Budgets',
  'Full infrastructure as AWS CDK (TypeScript) — synth-validated',
];
s.addText(deliver.map((t) => ({ text: t, options: { bullet: { code: '2022', indent: 15 }, color: DARK, fontSize: 18, paraSpaceAfter: 10 } })),
  { x: 0.7, y: 1.4, w: 12, h: 5 });

// --- Slide 3: Architecture diagram ---
s = pptx.addSlide();
titleBar(s, 'Target AWS Architecture');
const diag = path.join(OUT, 'Urbani_AWS_Architecture_Diagram.png');
s.addImage({ path: diag, x: 0.4, y: 1.25, w: 12.5, h: 6.0 });
s.addText('Custom web dashboard + AI log chatbot · read-only · human-in-the-loop · 5-min loop',
  { x: 0.5, y: 7.05, w: 12.3, h: 0.35, fontSize: 11, color: GREY, italic: true, align: 'center' });

// --- Slide 4: AI design & safeguards ---
s = pptx.addSlide();
titleBar(s, 'AI Design & Safeguards');
const rows = [
  [{ text: 'Aspect', options: { bold: true, color: 'FFFFFF', fill: { color: GOLD } } }, { text: 'Specification', options: { bold: true, color: 'FFFFFF', fill: { color: GOLD } } }],
  ['Primary model', 'Claude 3.5 Sonnet v2 (anthropic.claude-3-5-sonnet-20241022-v2:0)'],
  ['Fallback', 'Amazon Nova Pro / Nova Lite'],
  ['Inference', 'temperature 0.0 · max_tokens 1024 · top_p 1.0'],
  ['Guardrails', 'urbani-dpi-guardrail-v1 — PII redaction, injection defense'],
  ['Grounding', 'No evidence → NO_ANOMALY_DETECTED; chatbot never speculates'],
  ['Remediation', 'None — advisory only, human-in-the-loop'],
];
s.addTable(rows, { x: 0.7, y: 1.5, w: 12, colW: [3, 9], fontSize: 15, color: DARK, border: { type: 'solid', color: 'E5E7EB', pt: 1 }, valign: 'middle', rowH: 0.6 });

// --- Slide 5: Status & next steps ---
s = pptx.addSlide();
titleBar(s, 'Delivery Status & Next Steps');
s.addText('Delivered', { x: 0.7, y: 1.35, w: 6, h: 0.4, fontSize: 18, bold: true, color: GOLD });
s.addText(
  ['Custom dashboard + all pages', 'Production hardening + Docker', 'Live logs API (LIVE)', 'AI Log Chatbot', 'AWS CDK stack (synth-validated)'].map((t) => ({ text: t, options: { bullet: { code: '2022' }, color: DARK, fontSize: 15, paraSpaceAfter: 8 } })),
  { x: 0.8, y: 1.85, w: 5.7, h: 4 });
s.addText('Awaiting Client / AWS', { x: 6.9, y: 1.35, w: 6, h: 0.4, fontSize: 18, bold: true, color: DARK });
s.addText(
  ['Bedrock model + guardrail access', 'Metrics/services API endpoints', 'AWS account + IAM to deploy CDK', 'Real log activity (or history endpoint)', 'Rotate shared logs API key'].map((t) => ({ text: t, options: { bullet: { code: '2022' }, color: DARK, fontSize: 15, paraSpaceAfter: 8 } })),
  { x: 7.0, y: 1.85, w: 5.8, h: 4 });

pptx.writeFile({ fileName: path.join(OUT, 'Urbani_AWS_Architecture_v3.pptx') }).then((f) => console.log('Wrote ' + path.basename(f)));
