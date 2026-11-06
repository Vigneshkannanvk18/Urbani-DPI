import { Router } from 'express';
import { z } from 'zod';
import { HEALTH_RANGES } from '@urbani/shared';
import { asyncHandler } from '../lib/asyncHandler';
import { requirePermission } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { getRepositories } from '../repositories';
import { healthService } from '../services/healthService';

/**
 * Service health API (DPI 2 item 9), mounted at /api/health/*. The unauthenticated liveness / readiness probes
 * (/api/health, /api/ready) are separate and unchanged.
 *
 * Reading needs services:view. "Check now" runs the probes immediately and needs settings:update (Super Admin /
 * Infra Admin); it is rate limited and audited. Probe URLs come from env config only, never from a request.
 */
export const healthStatusRoutes = Router();

const historyQuery = z.object({
  target: z.string().min(1).max(64),
  range: z.enum(HEALTH_RANGES).default('24h'),
});

healthStatusRoutes.get(
  '/status',
  requirePermission('services:view'),
  asyncHandler(async (_req, res) => res.json({ data: await healthService.status() })),
);

healthStatusRoutes.get(
  '/history',
  requirePermission('services:view'),
  asyncHandler(async (req, res) => {
    const q = historyQuery.parse(req.query);
    res.json({ data: await healthService.history(q.target, q.range) });
  }),
);

healthStatusRoutes.post(
  '/check-now',
  requirePermission('settings:update'),
  rateLimit({ windowMs: 60_000, max: 5 }),
  asyncHandler(async (req, res) => {
    const out = await healthService.checkNow();
    const summary: Record<string, number> = {};
    for (const t of out.status.targets) summary[t.status] = (summary[t.status] ?? 0) + 1;
    // Counts only; no URLs.
    await getRepositories().audit.record(req.auth!.email, 'health.check_now', 'health', { checked: out.checked, statuses: summary });
    res.json({ data: out.status });
  }),
);
