# syntax=docker/dockerfile:1

# =============================================================================
# Backend image — multi-stage, non-root, minimal (Parts 4 & 34).
# Stage 1 builds the TypeScript (and compiles the better-sqlite3 native addon).
# Stage 2 is a slim runtime with only production node_modules + compiled output.
# =============================================================================

# ---- Stage 1: build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Toolchain for building better-sqlite3's native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install deps using the workspace manifests (shared + backend) for layer caching.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN npm ci

# Copy sources and build shared -> backend.
COPY packages/shared packages/shared
COPY packages/backend packages/backend
RUN npm run build --workspace @urbani/shared \
    && npm run build --workspace @urbani/backend

# Prune to production dependencies only (keeps the native addon).
RUN npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Non-root user (Part 34).
RUN groupadd --system urbani && useradd --system --gid urbani --home /app urbani

# Copy only what the runtime needs.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=build /app/packages/backend/dist ./packages/backend/dist

# Data directory for the SQLite volume mount; owned by the non-root user.
RUN mkdir -p /data && chown -R urbani:urbani /data /app
VOLUME ["/data"]

USER urbani
EXPOSE 4000

# Migrations run on startup (idempotent, non-destructive); seed/reset are explicit.
CMD ["node", "packages/backend/dist/server.js"]
