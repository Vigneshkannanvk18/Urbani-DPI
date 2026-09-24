# syntax=docker/dockerfile:1

# =============================================================================
# Frontend image — multi-stage (Parts 4 & 34).
# Stage 1 builds the static Vite bundle. Stage 2 serves it with nginx, which
# ALSO acts as the reverse proxy: it serves the SPA at / and proxies /api to the
# backend container. The browser therefore only ever talks to this one origin —
# the backend host is never exposed directly.
# =============================================================================

# ---- Stage 1: build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci

COPY packages/shared packages/shared
COPY packages/frontend packages/frontend
RUN npm run build --workspace @urbani/shared \
    && npm run build --workspace @urbani/frontend

# ---- Stage 2: serve (nginx reverse proxy + static host) ----
FROM nginx:1.27-alpine AS runtime

# Reverse-proxy + SPA config.
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Static assets.
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html

# nginx:alpine already runs workers as the non-root "nginx" user.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
