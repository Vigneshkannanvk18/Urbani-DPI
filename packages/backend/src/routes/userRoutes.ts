import { Router } from 'express';
import { z } from 'zod';
import { USER_ROLES } from '@urbani/shared';
import { asyncHandler } from '../lib/asyncHandler';
import { MIN_PASSWORD_LENGTH, userService } from '../services/userService';
import { mfaService } from '../services/mfaService';

/**
 * User management API (DPI 2 item 2). Mounted at /api/users behind
 * requirePermission('users:manage') (Super Admin only in the draft matrix).
 */
export const userRoutes = Router();

const password = z.string().min(MIN_PASSWORD_LENGTH).max(200);
const role = z.enum(USER_ROLES);

const createSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  role,
  password,
});

userRoutes.get(
  '/',
  asyncHandler(async (_req, res) => res.json({ data: await userService.list() })),
);

userRoutes.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    res.status(201).json({ data: await userService.create(req.auth!.email, body) });
  }),
);

userRoutes.put(
  '/:id/role',
  asyncHandler(async (req, res) => {
    const body = z.object({ role }).parse(req.body);
    res.json({ data: await userService.changeRole({ id: req.auth!.sub, email: req.auth!.email }, req.params.id, body.role) });
  }),
);

userRoutes.post(
  '/:id/deactivate',
  asyncHandler(async (req, res) => {
    res.json({ data: await userService.setActive({ id: req.auth!.sub, email: req.auth!.email }, req.params.id, false) });
  }),
);

userRoutes.post(
  '/:id/activate',
  asyncHandler(async (req, res) => {
    res.json({ data: await userService.setActive({ id: req.auth!.sub, email: req.auth!.email }, req.params.id, true) });
  }),
);

userRoutes.post(
  '/:id/reset-password',
  asyncHandler(async (req, res) => {
    const body = z.object({ password }).parse(req.body);
    await userService.resetPassword(req.auth!.email, req.params.id, body.password);
    res.json({ ok: true });
  }),
);

// DPI 2 item 5: clears MFA so a locked-out user can enrol again. Audited as mfa.reset.
userRoutes.post(
  '/:id/mfa/reset',
  asyncHandler(async (req, res) => {
    await mfaService.reset(req.auth!.email, req.params.id);
    res.json({ ok: true });
  }),
);