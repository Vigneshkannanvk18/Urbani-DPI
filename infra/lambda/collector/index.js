'use strict';
/**
 * UrbaniTelemetryCollectorFn — PLACEHOLDER handler.
 *
 * Phase-2/3 responsibility (to implement once AWS access is confirmed):
 *   1. Run a CloudWatch Logs Insights query over the last N minutes for the
 *      configured EB log group.
 *   2. Filter to error/exception lines, cap at MAX_LOG_LINES (~100).
 *   3. Invoke Amazon Bedrock (model from BEDROCK_MODEL_ID) with the guardrail,
 *      temperature 0.0, max_tokens 1024 — producing a strict UrbaniIncidentAlert JSON.
 *   4. Forward the finding to the Alert Writer (async invoke or EventBridge).
 *
 * READ-ONLY: this function must never write to production application infra.
 */
exports.handler = async (event) => {
  // TODO(phase2): implement CloudWatch Insights query + Bedrock invocation.
  console.log(JSON.stringify({ msg: 'collector invoked (placeholder)', at: new Date().toISOString() }));
  return { status: 'NOT_IMPLEMENTED', note: 'Collector logic is added when AWS access is confirmed.' };
};
