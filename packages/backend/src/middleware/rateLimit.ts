import type { Request, Response, NextFunction } from 'express';

/**
 * Minimal fixed-window in-memory rate limiter (Part 33). Dependency-free and
 * sufficient for protecting the login endpoint against brute force in a
 * single-instance deployment. For multi-instance production, swap the store for
 * Redis behind the same middleware signature (no call-site changes).
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(opts: { windowMs: number; max: number | (() => number); key?: (req: Request) => string }) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    // Test-suite switch only (set in test/setup.ts); never set in a real environment.
    if (process.env.RATE_LIMIT_DISABLED === '1') return next();
    const key = opts.key ? opts.key(req) : (req.ip ?? 'unknown');
    const max = typeof opts.max === 'function' ? opts.max() : opts.max;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Please try again later.',
          correlationId: req.correlationId,
        },
      });
      return;
    }
    next();
  };
}
