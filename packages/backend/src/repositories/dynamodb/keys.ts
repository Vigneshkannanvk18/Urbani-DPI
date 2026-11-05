import type { DataSource } from '@urbani/shared';

/**
 * Key schema of the single app table `${DYNAMODB_TABLE_PREFIX}App` (design §5.2). Keys are only ever
 * built here, never parsed back: ids and timestamps are always stored as separate attributes.
 */

/** The entityType values; every item except the never-written health sentinel carries one. */
export const ENTITY_TYPES = [
  'ROLE',
  'USER',
  'USER_EMAIL',
  'PREFS',
  'AUDIT',
  'ALERT',
  'SERVICE',
  'ENVIRONMENT',
  'LOG',
  'METRIC',
  'AI_ANALYSIS',
  'USAGE',
  'INTEGRATION',
  'CHAT_SESSION',
  'CHAT_MESSAGE',
  'CHAT_FEEDBACK',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface ItemKey {
  PK: string;
  SK: string;
}
export interface Gsi1Key {
  GSI1PK: string;
  GSI1SK: string;
}

/** DynamoDB key limits in UTF-8 bytes (the same limits apply to GSI1PK/GSI1SK). */
export const PARTITION_KEY_MAX_BYTES = 2048;
export const SORT_KEY_MAX_BYTES = 1024;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 1 <= UTF-8 bytes <= 2,048 [F34]. */
export function fitsPartitionKey(pk: string): boolean {
  const n = utf8Bytes(pk);
  return n >= 1 && n <= PARTITION_KEY_MAX_BYTES;
}

/** 1 <= UTF-8 bytes <= 1,024 [F34]. */
export function fitsSortKey(sk: string): boolean {
  const n = utf8Bytes(sk);
  return n >= 1 && n <= SORT_KEY_MAX_BYTES;
}

/** Key-size guard (§5.4): lookups whose key does not fit return their not-found result without a call. */
export function fitsKey(pk: string, sk: string): boolean {
  return fitsPartitionKey(pk) && fitsSortKey(sk);
}

// ---- Partition keys of the collection entities (PK = entity type) ----
export const ROLE_PK = 'ROLE';
export const USER_PK = 'USER';
export const USER_EMAIL_PK = 'USER_EMAIL';
export const PREFS_PK = 'PREFS';
export const AUDIT_PK = 'AUDIT';
export const ALERT_PK = 'ALERT';
export const SERVICE_PK = 'SERVICE';
export const ENVIRONMENT_PK = 'ENVIRONMENT';
export const LOG_PK = 'LOG';
export const METRIC_PK = 'METRIC';
export const AI_ANALYSIS_PK = 'AI_ANALYSIS';
export const USAGE_PK = 'USAGE';
export const INTEGRATION_PK = 'INTEGRATION';

// ---- Sort-key prefixes inside shared partitions ----
/** GSI1SK prefixes in an ALERTLINK#<alertId> partition. */
export const LOG_LINK_PREFIX = 'LOG#';
export const METRIC_LINK_PREFIX = 'METRIC#';
export const ANALYSIS_LINK_PREFIX = 'AI#';
/** SK prefixes in a CHAT#<sessionId> partition. */
export const CHAT_SESSION_SK = 'SESSION';
export const CHAT_MESSAGE_PREFIX = 'MSG#';
export const CHAT_FEEDBACK_PREFIX = 'FEEDBACK#';

export const roleKey = (roleId: string): ItemKey => ({ PK: ROLE_PK, SK: roleId });
export const userKey = (userId: string): ItemKey => ({ PK: USER_PK, SK: userId });
/** The email lock; the SK keeps the email's exact case. */
export const userEmailKey = (email: string): ItemKey => ({ PK: USER_EMAIL_PK, SK: email });
export const prefsKey = (userId: string): ItemKey => ({ PK: PREFS_PK, SK: userId });

export const auditSortKey = (timestamp: string, id: string): string => `${timestamp}#${id}`;
export const auditKey = (timestamp: string, id: string): ItemKey => ({ PK: AUDIT_PK, SK: auditSortKey(timestamp, id) });
export const auditActorPk = (actor: string): string => `ACTOR#${actor}`;
export const auditGsi1 = (actor: string, timestamp: string, id: string): Gsi1Key => ({
  GSI1PK: auditActorPk(actor),
  GSI1SK: auditSortKey(timestamp, id),
});

export const alertKey = (alertId: string): ItemKey => ({ PK: ALERT_PK, SK: alertId });
export const alertSourcePk = (source: DataSource): string => `ALERTSRC#${source}`;
export const alertGsi1 = (source: DataSource, alertId: string): Gsi1Key => ({
  GSI1PK: alertSourcePk(source),
  GSI1SK: alertId,
});
/** Sparse reverse index of the logs, metrics and analyses linked to an alert. */
export const alertLinkPk = (alertId: string): string => `ALERTLINK#${alertId}`;

export const serviceKey = (id: string): ItemKey => ({ PK: SERVICE_PK, SK: id });
export const environmentKey = (id: string): ItemKey => ({ PK: ENVIRONMENT_PK, SK: id });

export const logKey = (id: string): ItemKey => ({ PK: LOG_PK, SK: id });
export const logGsi1Sk = (timestamp: string, id: string): string => `${LOG_LINK_PREFIX}${timestamp}#${id}`;
export const metricKey = (id: string): ItemKey => ({ PK: METRIC_PK, SK: id });
export const metricGsi1Sk = (timestamp: string, id: string): string => `${METRIC_LINK_PREFIX}${timestamp}#${id}`;
export const analysisKey = (id: string): ItemKey => ({ PK: AI_ANALYSIS_PK, SK: id });
export const analysisGsi1Sk = (timestamp: string, id: string): string => `${ANALYSIS_LINK_PREFIX}${timestamp}#${id}`;

/** The natural key (date, modelId). */
export const usageKey = (date: string, modelId: string): ItemKey => ({ PK: USAGE_PK, SK: `${date}#${modelId}` });
export const integrationKey = (id: string): ItemKey => ({ PK: INTEGRATION_PK, SK: id });

export const chatPk = (sessionId: string): string => `CHAT#${sessionId}`;
export const chatSessionKey = (sessionId: string): ItemKey => ({ PK: chatPk(sessionId), SK: CHAT_SESSION_SK });
export const chatUserPk = (userId: string): string => `CHATUSER#${userId}`;
export const chatSessionGsi1 = (userId: string, updatedAt: string, sessionId: string): Gsi1Key => ({
  GSI1PK: chatUserPk(userId),
  GSI1SK: `${updatedAt}#${sessionId}`,
});
export const chatMessageKey = (sessionId: string, messageId: string): ItemKey => ({
  PK: chatPk(sessionId),
  SK: `${CHAT_MESSAGE_PREFIX}${messageId}`,
});
export const chatFeedbackKey = (sessionId: string, messageId: string): ItemKey => ({
  PK: chatPk(sessionId),
  SK: `${CHAT_FEEDBACK_PREFIX}${messageId}`,
});

/** Never written; health.ping only reads it. */
export const healthKey = (): ItemKey => ({ PK: 'HEALTH', SK: 'PING' });
