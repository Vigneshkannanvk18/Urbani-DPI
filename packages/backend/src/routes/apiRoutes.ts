import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { dashboardService } from '../services/dashboardService';
import { alertService } from '../services/alertService';
import { telemetryService } from '../services/telemetryService';
import { aiService } from '../services/aiService';
import { chatService } from '../services/chatService';
import { usageService } from '../services/usageService';
import { settingsService } from '../services/settingsService';
import { auditRepository } from '../repositories/auditRepository';
import { rateLimit } from '../middleware/rateLimit';

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
  asyncHandler(async (_req, res) => res.json(dashboardService.summary())),
);
apiRoutes.get(
  '/dashboard/health',
  asyncHandler(async (_req, res) => res.json(dashboardService.health())),
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
  asyncHandler(async (req, res) => {
    const filter = alertQuerySchema.parse(req.query);
    res.json(await alertService.list(filter));
  }),
);
apiRoutes.get(
  '/alerts/:id',
  asyncHandler(async (req, res) => {
    res.json(await alertService.get(req.params.id, req.auth!.email));
  }),
);
apiRoutes.post(
  '/alerts/:id/acknowledge',
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
  asyncHandler(async (req, res) => {
    res.json(await telemetryService.logs(logQuerySchema.parse(req.query)));
  }),
);

// -------------------- METRICS --------------------
const metricQuerySchema = z.object({
  service: z.string().optional(),
  environment: z.string().optional(),
});
apiRoutes.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    res.json(telemetryService.metrics(metricQuerySchema.parse(req.query)));
  }),
);

// -------------------- SERVICES --------------------
apiRoutes.get(
  '/services',
  asyncHandler(async (_req, res) => res.json(telemetryService.services())),
);
apiRoutes.get(
  '/services/:id',
  asyncHandler(async (req, res) => res.json(telemetryService.service(req.params.id))),
);

// -------------------- AI --------------------
apiRoutes.get(
  '/ai/analyses',
  asyncHandler(async (req, res) => {
    res.json(aiService.listAnalyses(pageSchema.parse(req.query)));
  }),
);
apiRoutes.get(
  '/ai/analyses/:id',
  asyncHandler(async (req, res) => res.json(aiService.getAnalysis(req.params.id))),
);
// Advisory analysis trigger (still human-in-the-loop; only produces a finding).
const analyzeSchema = z.object({ service: z.string(), environment: z.string() });
apiRoutes.post(
  '/ai/analyze',
  asyncHandler(async (req, res) => {
    const { service, environment } = analyzeSchema.parse(req.body);
    res.json(await aiService.analyze(service, environment));
  }),
);

// -------------------- CHAT (AI Log Chatbot) --------------------
// Natural-language Q&A grounded in the current log window. Advisory only.
// Rate limited to protect the model from runaway cost/abuse.
const chatSchema = z.object({
  question: z.string().min(1).max(1000),
  service: z.string().optional(),
  environment: z.string().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .max(20)
    .optional(),
});
apiRoutes.post(
  '/chat',
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
apiRoutes.get('/usage', asyncHandler(async (_req, res) => res.json(usageService.usage())));
apiRoutes.get('/usage/cost', asyncHandler(async (_req, res) => res.json(usageService.cost())));

// -------------------- AUDIT --------------------
const auditQuerySchema = pageSchema.extend({
  action: z.string().optional(),
  actor: z.string().optional(),
});
apiRoutes.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const q = auditQuerySchema.parse(req.query);
    const { items, total } = auditRepository.query(q);
    res.json({
      source: 'MOCK',
      sourceNote: 'Application-level audit events (Phase 1). CloudTrail integration in Phase 2.',
      data: { items, page: q.page ?? 1, pageSize: q.pageSize ?? 50, total },
    });
  }),
);

// -------------------- SETTINGS --------------------
apiRoutes.get('/settings', asyncHandler(async (_req, res) => res.json({ data: settingsService.get() })));
apiRoutes.put(
  '/settings',
  asyncHandler(async (req, res) => {
    res.json(settingsService.update(req.auth!.email, (req.body ?? {}) as Record<string, unknown>));
  }),
);
