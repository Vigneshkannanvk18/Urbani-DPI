/**
 * Non-secret QA observability pipeline facts (display copy only).
 *
 * These are the client-provided resource names/IDs for the Urbani QA AWS
 * account. They are NON-SECRET and may be shown in the UI (Settings). The API
 * key and base URL live in the gitignored .env, never here.
 */
export const URBANI_QA_PIPELINE = {
  region: 'us-east-1',
  collectorLambda: 'UrbaniTelemetryCollectorFn',
  eventBridgeRule: 'urbaniqa-qa-observability-collector-5m',
  collectorScheduleMinutes: 5,
  alertWriterLambda: 'UrbaniAlertWriterFn',
  duplicateSuppressionMinutes: 30,
  logsApiLambda: 'UrbaniLogsApiFn',
  alertsApiLambda: 'UrbaniAlertsApiFn',
  chatLambda: 'UrbaniChatFn',
  flow: 'ECS → CloudWatch Logs → Collector Lambda → Bedrock + Guardrail → Alert Writer → DynamoDB',
  registeredServices: [
    { name: 'main', enabled: true },
    { name: 'payments', enabled: true },
    { name: 'auth', enabled: false },
    { name: 'support', enabled: false },
  ],
} as const;
