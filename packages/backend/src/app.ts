import express, { type Express } from 'express';
import cors from 'cors';
import { config } from './config';
import { correlationId } from './middleware/correlationId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRoutes } from './routes/authRoutes';
import { apiRoutes } from './routes/apiRoutes';

/**
 * Express application (API Layer). Kept separate from server bootstrap so tests
 * can import the app without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.use(cors({ origin: config.api.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(correlationId);

  // Liveness/readiness (unauthenticated).
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', app: config.appName, env: config.env, integrationMode: config.integrationMode });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
