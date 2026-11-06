import { Router } from 'express';
import { z } from 'zod';
import { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES, SEVERITIES } from '@urbani/shared';
import { asyncHandler } from '../lib/asyncHandler';
import { AppError } from '../lib/errors';
import { requirePermission } from '../middleware/auth';
import { notificationService } from '../services/notificationService';

/**
 * Notification API (DPI 2 item 6). Reading needs alerts:view; changing rules/settings and test-sending need
 * alerts:rules (DRAFT matrix: Super Admin and Infra Admin). Webhook URLs are never returned.
 */
export const notificationRoutes = Router();

const list = z.array(z.string().trim().min(1).max(100)).max(50);
const channels = z.array(z.enum(NOTIFICATION_CHANNELS)).min(1).max(3).transform((c) => [...new Set(c)]);
const ruleBody = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  minSeverity: z.enum(SEVERITIES),
  services: list.default([]),
  anomalyTypes: list.default([]),
  channels,
});
const rulePatch = z
  .object({
    name: z.string().trim().min(1).max(100), enabled: z.boolean(), minSeverity: z.enum(SEVERITIES),
    services: list, anomalyTypes: list, channels,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
const settingsBody = z
  .object({
    dedupWindowMinutes: z.number().int().min(0).max(10_080),
    maxPerHourPerChannel: z.number().int().min(1).max(1000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
const logQuery = z.object({
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  alertId: z.string().trim().min(1).max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});
const testBody = z.object({ channel: z.enum(NOTIFICATION_CHANNELS), severity: z.enum(SEVERITIES).default('CRITICAL') });

// Test-send limiter: 5 per minute per user (in memory; a second task has its own counter, which is acceptable here).
const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 60_000;
const testHits = new Map<string, number[]>();
export function resetTestSendLimiter(): void {
  testHits.clear();
}
function checkTestLimit(userId: string): void {
  const now = Date.now();
  const hits = (testHits.get(userId) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (hits.length >= TEST_LIMIT) {
    throw new AppError('RATE_LIMITED', 'Too many test sends. Try again in a minute.', 429);
  }
  hits.push(now);
  testHits.set(userId, hits);
}

notificationRoutes.get('/channels', requirePermission('alerts:view'), (_req, res) => {
  res.json({ data: notificationService.channels() });
});

notificationRoutes.get('/rules', requirePermission('alerts:view'), asyncHandler(async (_req, res) => {
  res.json({ data: await notificationService.listRules() });
}));
notificationRoutes.post('/rules', requirePermission('alerts:rules'), asyncHandler(async (req, res) => {
  const body = ruleBody.parse(req.body);
  res.status(201).json({ data: await notificationService.createRule(req.auth!.email, body) });
}));
notificationRoutes.put('/rules/:id', requirePermission('alerts:rules'), asyncHandler(async (req, res) => {
  const body = rulePatch.parse(req.body);
  res.json({ data: await notificationService.updateRule(req.auth!.email, req.params.id, body) });
}));
notificationRoutes.delete('/rules/:id', requirePermission('alerts:rules'), asyncHandler(async (req, res) => {
  await notificationService.deleteRule(req.auth!.email, req.params.id);
  res.json({ data: { id: req.params.id, deleted: true } });
}));

notificationRoutes.get('/settings', requirePermission('alerts:view'), asyncHandler(async (_req, res) => {
  res.json({ data: await notificationService.getSettings() });
}));
notificationRoutes.put('/settings', requirePermission('alerts:rules'), asyncHandler(async (req, res) => {
  res.json({ data: await notificationService.updateSettings(req.auth!.email, settingsBody.parse(req.body)) });
}));

notificationRoutes.get('/log', requirePermission('alerts:view'), asyncHandler(async (req, res) => {
  const q = logQuery.parse(req.query);
  const { items, total } = await notificationService.log(q);
  res.json({ data: { items, page: q.page ?? 1, pageSize: q.pageSize ?? 50, total } });
}));

notificationRoutes.post('/test', requirePermission('alerts:rules'), asyncHandler(async (req, res) => {
  const body = testBody.parse(req.body);
  checkTestLimit(req.auth!.sub);
  res.json({ data: await notificationService.testSend(req.auth!.email, body.channel, body.severity) });
}));
