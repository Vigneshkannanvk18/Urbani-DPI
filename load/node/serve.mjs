#!/usr/bin/env node
/**
 * Starts the COMPILED backend locally for load tests (dev-only; no dependencies).
 *   npm run build
 *   node load/node/serve.mjs --volume 50000 --port 4100 [--db .tmp/load/db.sqlite] [--driver sqlite|dynamodb]
 *
 * Always INTEGRATION_MODE=mock (no AWS, no Urbani API). Rate limits are disabled (RATE_LIMIT_DISABLED=1) unless
 * --limits is passed: the load runner uses one admin token from one IP, which the per-IP / per-user limiters
 * would (correctly) throttle. A fresh worktree-local SQLite database is migrated and seeded on every start.
 * Stop it with Ctrl+C (or kill the process); it prints "READY" when it listens.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const port = String(args.port ?? 4100);
const volume = String(args.volume ?? 0);
const dbFile = path.resolve(ROOT, args.db ?? '.tmp/load/db.sqlite');
const driver = args.driver ?? 'sqlite';
const backendDir = path.join(ROOT, 'packages', 'backend');
const dist = path.join(backendDir, 'dist');
if (!fs.existsSync(path.join(dist, 'server.js'))) {
  console.error('packages/backend/dist is missing: run `npm run build` first');
  process.exit(2);
}
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: port,
  INTEGRATION_MODE: 'mock',
  DB_DRIVER: driver,
  DATABASE_URL: dbFile,
  JWT_SECRET: 'load-test-secret-not-for-production',
  SEED_ADMIN_EMAIL: process.env.LOAD_ADMIN_EMAIL ?? 'admin@urbani.local',
  SEED_ADMIN_PASSWORD: process.env.LOAD_ADMIN_PASSWORD ?? 'LoadTest-Passw0rd!',
  LOG_LEVEL: 'warn',
  MOCK_LOG_VOLUME: volume,
  HEALTH_PROBE_INTERVAL_SECONDS: '60',
  URBANI_API_BASE_URL: '',
  URBANI_API_KEY: '',
  ...(args.limits ? {} : { RATE_LIMIT_DISABLED: '1' }),
  ...(args.exportRows ? { EXPORT_MAX_ROWS: String(args.exportRows) } : {}),
};
for (const script of ['migrate.js', 'seed.js']) {
  const r = spawnSync(process.execPath, [path.join(dist, 'db', script)], { cwd: backendDir, env, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`${script} failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
    process.exit(1);
  }
}
const child = spawn(process.execPath, [...(args.heap ? [`--max-old-space-size=${args.heap}`] : []), path.join(dist, 'server.js')], { cwd: backendDir, env, stdio: 'inherit' });
console.log(`READY-PENDING backend pid=${child.pid} port=${port} volume=${volume} db=${dbFile}`);
const stop = () => { try { child.kill(); } catch { /* gone */ } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
