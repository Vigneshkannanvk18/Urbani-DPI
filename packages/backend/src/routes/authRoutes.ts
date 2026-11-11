import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { authService } from '../services/authService';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuthOrEnroll } from '../middleware/auth';
import { mfaService } from '../services/mfaService';
import { SSO_COOKIE, SsoError, ssoService } from '../services/ssoService';
import { config } from '../config';

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
    await authService.logout(req.auth!.email);
    res.json({ ok: true });
  }),
);

authRoutes.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: await authService.me(req.auth!.sub) });
  }),
);

// ---------------------------------------------------------------- SSO (OIDC)
authRoutes.get('/config', (_req, res) => res.json(ssoService.publicConfig()));

authRoutes.get(
  '/sso/login',
  rateLimit({ windowMs: 60_000, max: 30 }),
  asyncHandler(async (_req, res) => {
    const { redirectUrl, cookie, maxAge } = await ssoService.begin();
    // Signed, short-lived, HttpOnly; Lax so it is sent on the top-level redirect back from the IdP.
    res.setHeader('Set-Cookie', `${SSO_COOKIE}=${encodeURIComponent(cookie)}; Path=/api/auth/sso; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${config.isProd ? '; Secure' : ''}`);
    res.redirect(302, redirectUrl);
  }),
);

function renderSsoError(req: Request, res: Response, err: SsoError): void {
  res.setHeader('Set-Cookie', `${SSO_COOKIE}=; Path=/api/auth/sso; Max-Age=0; HttpOnly; SameSite=Lax`);
  if ((req.header('accept') ?? '').includes('application/json')) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message, correlationId: req.correlationId } });
    return;
  }
  // Browsers land back on the app's own (styled) login page; only the stable error code is passed,
  // the SPA maps it to a message.
  res.redirect(302, `/login?sso_error=${encodeURIComponent(err.code)}`);
}

authRoutes.get(
  '/sso/callback',
  rateLimit({ windowMs: 60_000, max: 30 }),
  asyncHandler(async (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const session = await ssoService.complete({ code: q.code, state: q.state, error: q.error }, req.header('cookie'));
      res.setHeader('Set-Cookie', `${SSO_COOKIE}=; Path=/api/auth/sso; Max-Age=0; HttpOnly; SameSite=Lax`);
      // The token travels in the URL fragment (never sent to a server or logged); the SPA stores it like a local login.
      res.redirect(302, `/sso-callback#token=${encodeURIComponent(session.token)}`);
    } catch (err) {
      if (err instanceof SsoError) {
        await ssoService.auditDenied(err);
        return renderSsoError(req, res, err);
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------- MFA
const codeField = z.string().trim().min(1).max(64);
const credential = z
  .object({ code: codeField.optional(), recoveryCode: codeField.optional() })
  .refine((c) => Boolean(c.code) !== Boolean(c.recoveryCode), { message: 'Provide either code or recoveryCode' });

authRoutes.post(
  '/mfa/verify',
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    const body = z.object({ mfaToken: z.string().min(1) }).and(credential).parse(req.body);
    res.json(await mfaService.verifyLogin(body.mfaToken, body));
  }),
);

authRoutes.get(
  '/mfa/status',
  requireAuthOrEnroll,
  asyncHandler(async (req, res) => res.json(await mfaService.status(req.auth!.sub))),
);

authRoutes.post(
  '/mfa/enroll/start',
  requireAuthOrEnroll,
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => res.json(await mfaService.startEnrol(req.auth!.sub))),
);

authRoutes.post(
  '/mfa/enroll/confirm',
  requireAuthOrEnroll,
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    const { code } = z.object({ code: codeField }).parse(req.body);
    res.json(await mfaService.confirmEnrol(req.auth!.sub, code, req.enrollOnly === true));
  }),
);

authRoutes.post(
  '/mfa/disable',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    const body = z.object({ password: z.string().min(1) }).and(credential).parse(req.body);
    await mfaService.disable(req.auth!.sub, body.password, body);
    res.json({ ok: true });
  }),
);

authRoutes.post(
  '/mfa/recovery-codes/regenerate',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    const body = z.object({ password: z.string().min(1) }).and(credential).parse(req.body);
    res.json({ recoveryCodes: await mfaService.regenerateRecoveryCodes(req.auth!.sub, body.password, body) });
  }),
);
