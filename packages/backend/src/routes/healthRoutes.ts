import { Router } from 'express';
import { config } from '../config';
import { getDb } from '../db/connection';

/**
 * Health & readiness probes (Part 7).
 *
 *  GET /health  — liveness: the process is up and serving. No dependency checks.
 *  GET /ready   — readiness: verifies the database is reachable. Returns 503 if not.
 *
 * Neither response exposes secrets, credentials, or internal configuration values.
 */
export const healthRoutes = Router();

healthRoutes.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: config.appName,
    env: config.env,
    integrationMode: config.integrationMode,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

healthRoutes.get('/ready', (_req, res) => {
  const checks: Record<string, 'ok' | 'unavailable'> = {};

  // Database check: a trivial query confirms the connection is usable.
  try {
    getDb().prepare('SELECT 1').get();
    checks.database = 'ok';
  } catch {
    checks.database = 'unavailable';
  }

  const ready = Object.values(checks).every((v) => v === 'ok');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not-ready',
    checks,
  });
});
