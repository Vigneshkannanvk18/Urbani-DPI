import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth, requirePermission } from '../middleware/auth';
import { dashboardService } from '../services/dashboardService';
import { alertService } from '../services/alertService';
import { telemetryService } from '../services/telemetryService';
import { aiService } from '../services/aiService';
import { chatService } from '../services/chatService';
import { usageService } from '../services/usageService';
import { settingsService } from '../services/settingsService';
import { getRepositories } from '../repositories';
import { rateLimit } from '../middleware/rateLimit';
import { userRoutes } from './userRoutes';
import { auditService } from '../services/auditService';
import { AUDIT_CATEGORIES, AUDIT_RESULTS } from '@urbani/shared';

/**
 * Protected API routes (Epic 10). Every route here requires authentication
 * (Task 2.3). Naming follows the documented API contract exactly.
 */
export const apiRoutes = Router();

// All admin APIs require a valid token.
apiRoutes.use(requireAuth);

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

// -------------------- DASHBOARD --------------------
apiRoutes.get(
  '/dashboard/summary',
  requirePermission('dashboard:view'),
  asyncHandler(async (_req, res) => res.json(await dashboardService.summary())),
);
apiRoutes.get(
  '/dashboard/health',
  requirePermission('dashboard:view'),
  asyncHandler(async (_req, res) => res.json(await dashboardService.health())),
);

// -------------------- ALERTS --------------------
const alertQuerySchema = pageSchema.extend({
  service: z.string().optional(),
  environment: z.string().optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  anomalyType: z.string().optional(),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']).optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

apiRoutes.get(
  '/alerts',
  requirePermission('alerts:view'),
  asyncHandler(async (req, res) => {
    const filter = alertQuerySchema.parse(req.query);
    res.json(await alertService.list(filter));
  }),
);
apiRoutes.get(
  '/alerts/:id',
  requirePermission('alerts:view'),
  asyncHandler(async (req, res) => {
    res.json(await alertService.get(req.params.id, req.auth!.email));
  }),
);
apiRoutes.post(
  '/alerts/:id/acknowledge',
  requirePermission('alerts:acknowledge'),
  asyncHandler(async (req, res) => {
    res.json(await alertService.acknowledge(req.params.id, req.auth!.email));
  }),
);

// -------------------- LOGS --------------------
const logQuerySchema = pageSchema.extend({
  service: z.string().optional(),
  environment: z.string().optional(),
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']).optional(),
  search: z.string().optional(),
});
apiRoutes.get(
  '/logs',
  requirePermission('logs:view'),
  asyncHandler(async (req, res) => {
    const filter = logQuerySchema.parse(req.query);
    const out = await telemetryService.logs(filter);
    // Filter parameters only; never the log content.
    await getRepositories().audit.record(req.auth!.email, 'logs.search', 'logs', { ...filter });
    res.json(out);
  }),
);

// -------------------- METRICS --------------------
const metricQuerySchema = z.object({
  service: z.string().optional(),
  environment: z.string().optional(),
});
apiRoutes.get(
  '/metrics',
  requirePermission('metrics:view'),
  asyncHandler(async (req, res) => {
    res.json(await telemetryService.metrics(metricQuerySchema.parse(req.query)));
  }),
);

// -------------------- SERVICES --------------------
apiRoutes.get(
  '/services',
  requirePermission('services:view'),
  asyncHandler(async (_req, res) => res.json(await telemetryService.services())),
);
apiRoutes.get(
  '/services/:id',
  requirePermission('services:view'),
  asyncHandler(async (req, res) => res.json(await telemetryService.service(req.params.id))),
);

// -------------------- AI --------------------
apiRoutes.get(
  '/ai/analyses',
  requirePermission('ai:view'),
  asyncHandler(async (req, res) => {
    res.json(await aiService.listAnalyses(pageSchema.parse(req.query)));
  }),
);
apiRoutes.get(
  '/ai/analyses/:id',
  requirePermission('ai:view'),
  asyncHandler(async (req, res) => res.json(await aiService.getAnalysis(req.params.id))),
);
// Advisory analysis trigger (still human-in-the-loop; only produces a finding).
const analyzeSchema = z.object({ service: z.string(), environment: z.string() });
apiRoutes.post(
  '/ai/analyze',
  requirePermission('ai:analyze'),
  asyncHandler(async (req, res) => {
    const { service, environment } = analyzeSchema.parse(req.body);
    const out = await aiService.analyze(service, environment);
    await getRepositories().audit.record(req.auth!.email, 'ai.analyze', `${service}/${environment}`, { service, environment });
    res.json(out);
  }),
);

// -------------------- CHAT (AI Log Chatbot) --------------------
// Natural-language Q&A grounded in the current log window. Advisory only.
// Rate limited to protect the model from runaway cost/abuse.
const chatSchema = z.object({
  // Trim so a whitespace-only question is rejected (400) BEFORE a billed /chat call.
  question: z.string().trim().min(1).max(1000),
  service: z.string().optional(),
  environment: z.string().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .max(20)
    .optional(),
});
apiRoutes.post(
  '/chat',
  requirePermission('chat:use'),
  rateLimit({ windowMs: 60_000, max: 30 }),
  asyncHandler(async (req, res) => {
    const body = chatSchema.parse(req.body);
    res.json(
      await chatService.ask(body.question, {
        service: body.service,
        environment: body.environment,
        history: body.history,
        actor: req.auth!.email,
      }),
    );
  }),
);

// -------------------- USAGE --------------------
apiRoutes.get('/usage', requirePermission('usage:view'), asyncHandler(async (_req, res) => res.json(await usageService.usage())));
apiRoutes.get('/usage/cost', requirePermission('usage:view'), asyncHandler(async (_req, res) => res.json(await usageService.cost())));

// -------------------- AUDIT --------------------
const auditQuerySchema = pageSchema.extend({
  action: z.string().optional(),
  actor: z.string().optional(),
  // DPI 2 item 3 (cursor mode): presence of any of these switches to the cursor response.
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  userId: z.string().min(1).max(128).optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  text: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const AUDIT_NOTE = 'Application-level audit events (append-only). CloudTrail integration is a later phase.';
apiRoutes.get(
  '/audit/actions',
  requirePermission('audit:view'),
  asyncHandler(async (_req, res) =>
    res.json({
      source: 'MOCK',
      sourceNote: AUDIT_NOTE,
      data: { actions: auditService.actions(), categories: auditService.categories, results: auditService.results },
    }),
  ),
);
apiRoutes.get(
  '/audit',
  requirePermission('audit:view'),
  asyncHandler(async (req, res) => {
    const q = auditQuerySchema.parse(req.query);
    const cursorMode = ['from', 'to', 'userId', 'result', 'category', 'text', 'cursor', 'limit'].some(
      (k) => (q as Record<string, unknown>)[k] !== undefined,
    );
    const { page: _page, pageSize: _pageSize, ...filters } = q;
    if (cursorMode) {
      const out = await auditService.search({ ...filters, action: q.action });
      await getRepositories().audit.record(req.auth!.email, 'audit.view', 'audit', { ...filters });
      return res.json({
        source: 'MOCK',
        sourceNote: AUDIT_NOTE,
        data: { items: out.items, nextCursor: out.nextCursor, limit: q.limit ?? 50 },
      });
    }
    const { items, total } = await getRepositories().audit.query(q);
    await getRepositories().audit.record(req.auth!.email, 'audit.view', 'audit', { ...filters });
    res.json({
      source: 'MOCK',
      sourceNote: AUDIT_NOTE,
      data: { items, page: q.page ?? 1, pageSize: q.pageSize ?? 50, total },
    });
  }),
);
// -------------------- SETTINGS --------------------
apiRoutes.get('/settings', requirePermission('settings:view'), asyncHandler(async (_req, res) => res.json({ data: await settingsService.get() })));
apiRoutes.put(
  '/settings',
  requirePermission('settings:update'),
  asyncHandler(async (req, res) => {
    res.json(await settingsService.update(req.auth!.email, (req.body ?? {}) as Record<string, unknown>));
  }),
);

// -------------------- USER MANAGEMENT (Super Admin only; users:manage) --------------------
apiRoutes.use('/users', requirePermission('users:manage'), userRoutes);
