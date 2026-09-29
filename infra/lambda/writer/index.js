'use strict';
/**
 * UrbaniAlertWriterFn — PLACEHOLDER handler.
 *
 * Phase-2/3 responsibility:
 *   1. Receive the structured finding (UrbaniIncidentAlert JSON) from the collector.
 *   2. Validate against the JSON schema (reject anything malformed).
 *   3. PutItem into the DynamoDB UrbaniAlerts table (PK service_id, SK timestamp).
 *
 * Advisory pipeline only — writing an alert never triggers remediation.
 */
exports.handler = async (event) => {
  // TODO(phase2): validate schema + DynamoDB PutItem using ALERTS_TABLE.
  console.log(JSON.stringify({ msg: 'writer invoked (placeholder)', at: new Date().toISOString() }));
  return { status: 'NOT_IMPLEMENTED', note: 'Writer logic is added when AWS access is confirmed.' };
};
