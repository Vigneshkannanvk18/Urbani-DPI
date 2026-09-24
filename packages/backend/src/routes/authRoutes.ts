import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { authService } from '../services/authService';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';

/**
 * AUTH routes (Epic 2 / API contract).
 *   POST /api/auth/login
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 */
export const authRoutes = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Throttle login attempts: 10 per minute per IP (brute-force mitigation).
authRoutes.post(
  '/login',
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const result = await authService.login(email, password);
    res.json(result);
  }),
);

authRoutes.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    authService.logout(req.auth!.email);
    res.json({ ok: true });
  }),
);

authRoutes.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: authService.me(req.auth!.sub) });
  }),
);
