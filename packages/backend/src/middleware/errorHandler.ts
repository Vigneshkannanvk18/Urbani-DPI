import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@urbani/shared';
import { AppError } from '../lib/errors';

/**
 * Terminal error handler (Task 1.4). Normalizes any thrown error into the
 * shared ApiError shape and never leaks stack traces or secrets to clients.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const correlationId = req.correlationId;

  if (err instanceof ZodError) {
    req.log?.warn('Validation error', { issues: err.issues });
    const body: ApiError = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues,
        correlationId,
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof AppError) {
    // Client (4xx) errors are expected; only log 5xx as errors.
    const logFn = err.statusCode >= 500 ? req.log?.error : req.log?.warn;
    logFn?.(err.message, { code: err.code, statusCode: err.statusCode });
    const body: ApiError = {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        correlationId,
      },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // Unknown/unexpected error: log full detail server-side, return opaque message.
  const message = err instanceof Error ? err.message : 'Unknown error';
  req.log?.error('Unhandled error', { message });
  const body: ApiError = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      correlationId,
    },
  };
  res.status(500).json(body);
}

/** 404 fallback for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiError = {
    error: {
      code: 'NOT_FOUND',
      message: `Route not found: ${req.method} ${req.path}`,
      correlationId: req.correlationId,
    },
  };
  res.status(404).json(body);
}
