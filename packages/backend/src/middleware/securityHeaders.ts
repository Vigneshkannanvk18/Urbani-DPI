import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Security headers (Part 33). Implemented directly to avoid an extra dependency
 * and keep the container image minimal (Part 34). The API serves JSON only, so
 * the CSP is intentionally strict; the frontend (static assets) is served and
 * secured separately by the nginx reverse proxy.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // API responses are JSON; disallow any embedded/active content.
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  // Only advertise HSTS in production over TLS-terminating proxies.
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Never leak the framework/version.
  res.removeHeader('X-Powered-By');
  next();
}
