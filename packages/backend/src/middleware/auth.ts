import type { Request, Response, NextFunction } from 'express';
import { authService, type TokenPayload } from '../services/authService';
import { UnauthorizedError, ForbiddenError } from '../lib/errors';

/**
 * Auth middleware (Epic 2 / Task 2.3). All administrative APIs require a valid
 * bearer token. Unauthorized/expired tokens yield a 401 via the error handler.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: TokenPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing bearer token'));
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    req.auth = authService.verify(token);
    next();
  } catch (err) {
    next(err);
  }
}

/** Role guard. Kept intentionally minimal — not a full RBAC engine. */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(new UnauthorizedError());
    if (!roles.includes(req.auth.role)) {
      return next(new ForbiddenError(`Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}
