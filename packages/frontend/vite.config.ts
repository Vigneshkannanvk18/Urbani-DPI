import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config — DEVELOPMENT TOOLING ONLY. This never affects the production
 * bundle: in Docker/prod the SPA is served by nginx and /api is reverse-proxied,
 * so the browser uses the relative `/api` path with no host.
 *
 * For local `npm run dev`, the dev server proxies /api to the backend. The
 * target is fully env-driven (no hardcoded host); it is assembled from
 * VITE_DEV_API_HOST / VITE_DEV_API_PORT, or VITE_API_TARGET if provided.
 * Defaults point at the developer's own machine loopback (127.0.0.1) which is
 * where `npm run dev:backend` runs — not a service host baked into app code.
 */
const devApiHost = process.env.VITE_DEV_API_HOST ?? '127.0.0.1';
const devApiPort = process.env.VITE_DEV_API_PORT ?? '4000';
const devApiTarget = process.env.VITE_API_TARGET ?? `http://${devApiHost}:${devApiPort}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The @urbani/shared package ships a CommonJS build whose named exports
      // Rollup can't statically detect through its re-export barrel. The
      // assistant markdown renderer needs the pure helper's RUNTIME exports, so
      // alias the subpath to its TypeScript SOURCE — Vite/esbuild compiles it on
      // the fly and reads native ESM exports. (Type-only imports from the barrel
      // are erased and remain unaffected.)
      '@urbani/shared/markdown': fileURLToPath(
        new URL('../shared/src/markdown.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: true, // listen on all interfaces so it works inside a dev container too
    port: Number(process.env.VITE_DEV_PORT ?? 5173),
    proxy: {
      '/api': {
        target: devApiTarget,
        changeOrigin: true,
      },
    },
  },
});
