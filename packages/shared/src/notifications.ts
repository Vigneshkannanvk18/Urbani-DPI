import type { Severity } from './alerts';

/**
 * Notification vocabulary shared by backend and frontend (DPI 2 item 6).
 * Webhook URLs are secrets and never appear in any of these types.
 */
export const NOTIFICATION_CHANNELS = ['EMAIL', 'SLACK', 'TEAMS'] as const;
export type NotificationChannelName = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = [
  'SENT',
  'FAILED',
  'DRY_RUN',
  'SKIPPED_DEDUP',
  'SKIPPED_RATE_LIMIT',
  'SKIPPED_NOT_CONFIGURED',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const CHANNEL_CONFIG_STATUSES = ['CONFIGURED', 'NOT_CONFIGURED', 'DRY_RUN'] as const;
export type ChannelConfigStatus = (typeof CHANNEL_CONFIG_STATUSES)[number];

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  minSeverity: Severity;
  /** Empty = all services. */
  services: string[];
  /** Empty = all anomaly types. */
  anomalyTypes: string[];
  channels: NotificationChannelName[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationSettings {
  dedupWindowMinutes: number;
  maxPerHourPerChannel: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface NotificationLogEntry {
  id: string;
  timestamp: string;
  alertId: string | null;
  ruleId: string | null;
  channel: NotificationChannelName;
  status: NotificationStatus;
  attempts: number;
  /** Redacted: never contains a URL. */
  error: string | null;
  providerMessageId: string | null;
  isTest: boolean;
  /** One-line description of the message (what was or would have been sent). */
  summary: string | null;
}

export interface NotificationChannelStatus {
  channel: NotificationChannelName;
  status: ChannelConfigStatus;
  /** Masked destination (host only, or the SNS topic name). Never the URL. */
  destination: string | null;
  /** Human reason when NOT_CONFIGURED (e.g. "host not on the allow-list"). */
  reason: string | null;
}

/** DRAFT default rule id (pending client input #7). */
export const DEFAULT_NOTIFICATION_RULE_ID = 'rule-default-critical-high';
