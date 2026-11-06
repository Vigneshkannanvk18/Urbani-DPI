import {
  AUDIT_ACTION_CATALOG,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_RESULTS,
  auditActionsForCategory,
  type AuditAction,
  type AuditCategory,
  type AuditResult,
} from '@urbani/shared';
import { config } from '../config';
import { logger } from '../lib/logger';
import { getRepositories } from '../repositories';
import type { AuditEventRecord } from '../repositories/types';

/** Audit read side + retention (DPI 2 item 3). The log is append-only: no update/delete API exists. */
export interface AuditSearch {
  from?: string;
  to?: string;
  actor?: string;
  userId?: string;
  action?: string;
  result?: AuditResult;
  category?: AuditCategory;
  text?: string;
  limit?: number;
  cursor?: string;
}

export const auditService = {
  actions(): { action: AuditAction; category: AuditCategory; description: string }[] {
    return AUDIT_ACTIONS.map((a) => ({ action: a, ...AUDIT_ACTION_CATALOG[a] }));
  },
  categories: AUDIT_CATEGORIES,
  results: AUDIT_RESULTS,

  async search(q: AuditSearch): Promise<{ items: AuditEventRecord[]; nextCursor: string | null }> {
    let actions: string[] | undefined;
    if (q.category) actions = auditActionsForCategory(q.category);
    if (q.action) actions = actions ? actions.filter((a) => a === q.action) : [q.action];
    return getRepositories().audit.listByTimeRange({
      from: q.from,
      to: q.to,
      actor: q.actor,
      actions,
      result: q.result,
      text: q.text,
      metadataContains: q.userId ? `"userId":${JSON.stringify(q.userId)}` : undefined,
      limit: q.limit,
      cursor: q.cursor,
    });
  },

  /** Deletes events older than the retention window and records ONE summary event. No-op when retention is 0. */
  async purgeExpired(now: Date = new Date(), days = config.audit.retentionDays): Promise<number | null> {
    if (days <= 0) return null;
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const repos = getRepositories();
    const purged = await repos.audit.purgeOlderThan(cutoff);
    await repos.audit.record('system', 'audit.purge', undefined, { purged, cutoff, retentionDays: days });
    return purged;
  },
};

/** Runs the purge once now and then every 24h. Returns a stop function. */
export function startAuditRetentionJob(): () => void {
  if (!config.audit.retentionJobEnabled || config.audit.retentionDays <= 0) {
    logger.info('Audit retention job not running', {
      enabled: config.audit.retentionJobEnabled,
      retentionDays: config.audit.retentionDays,
    });
    return () => undefined;
  }
  const run = () =>
    auditService
      .purgeExpired()
      .then((n) => logger.info('Audit retention purge done', { purged: n }))
      .catch((err) => logger.warn('Audit retention purge failed', { error: err instanceof Error ? err.message : String(err) }));
  void run();
  const timer = setInterval(run, 24 * 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
