import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger, type Logger } from '../lib/logger';

/**
 * Request correlation IDs (Task 1.4).
 *
 * Accepts an inbound `x-correlation-id` (useful once the Lambda pipeline calls
 * the API) or generates one. Attaches a child logger to the request so every
 * downstream log line is traceable to a single request.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      log: Logger;
    }
  }
}

export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-correlation-id');
  const id = inbound && inbound.length <= 128 ? inbound : randomUUID();
  req.correlationId = id;
  req.log = logger.child({ correlationId: id });
  res.setHeader('x-correlation-id', id);
  next();
}
