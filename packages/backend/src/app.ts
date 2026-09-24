import express, { type Express } from 'express';
import cors from 'cors';
import { config } from './config';
import { correlationId } from './middleware/correlationId';
import { securityHeaders } from './middleware/securityHeaders';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRoutes } from './routes/authRoutes';
import { apiRoutes } from './routes/apiRoutes';
import { healthRoutes } from './routes/healthRoutes';

/**
 * Express application (API Layer). Kept separate from server bootstrap so tests
 * can import the app without binding a port.
 *
 * Production hardening (Phase 2): environment-driven CORS, security headers,
 * and dedicated health/readiness probes. No business logic changed.
 */
export function createApp(): Express {
  const app = express();

  // Trust the reverse proxy (nginx / load balancer) so req.ip and protocol are correct.
  app.set('trust proxy', 1);

  app.use(securityHeaders);

  // CORS: if an allow-list is configured, enforce it; otherwise operate same-origin
  // (the browser reaches the API through the reverse proxy, so no CORS is needed).
  app.use(
    cors({
      origin: config.api.corsOrigins.length > 0 ? config.api.corsOrigins : false,
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(correlationId);

  // Health & readiness probes (unauthenticated, no secrets). Mounted at both the
  // root and under /api so they work whether or not the proxy strips the prefix.
  app.use('/', healthRoutes);
  app.use('/api', healthRoutes);

  app.use('/api/auth', authRoutes);
  app.use('/api', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
