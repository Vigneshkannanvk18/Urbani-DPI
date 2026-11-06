import type { Request, Response, NextFunction } from 'express';
import { roleHasPermission, type Permission } from '@urbani/shared';
import { authService, type TokenPayload } from '../services/authService';
import { UnauthorizedError, ForbiddenError } from '../lib/errors';
import { getRepositories } from '../repositories';
import { logger } from '../lib/logger';
import { setAuditActor } from '../lib/auditMetadata';

/**
 * Auth middleware (Epic 2 / Task 2.3, RBAC in DPI 2 item 2). All administrative APIs require a
 * valid bearer token. The user is re-loaded on every request, so req.auth.role always reflects the
 * stored role and a deactivated user is rejected immediately (401), even with an unexpired token.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: TokenPayload;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing bearer token'));
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = authService.verify(token);
    const user = await authService.activeUser(payload.sub);
    req.auth = { sub: user.id, email: user.email, role: user.role };
    setAuditActor({ userId: user.id, email: user.email, role: user.role });
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Server-side permission guard (401 unauthenticated, 403 forbidden). Permission matrix: packages/shared/src/rbac.ts (DRAFT).
 * Passes if the role holds ANY of the listed permissions.
 */
export function requirePermission(...permissions: Permission[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) return next(new UnauthorizedError());
    if (permissions.some((p) => roleHasPermission(req.auth!.role, p))) return next();
    try {
      await getRepositories().audit.record(
        req.auth.email,
        'access.denied',
        `${req.method} ${req.baseUrl}${req.path}`,
        { required: permissions },
        'DENIED',
      );
    } catch (err) {
      logger.warn('Failed to audit access.denied', { error: err instanceof Error ? err.message : String(err) });
    }
    next(new ForbiddenError(`Your role (${req.auth.role}) lacks permission: ${permissions.join(' or ')}`));
  };
}
