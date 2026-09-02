# syntax=docker/dockerfile:1.7

# ---------- Dependencies ----------
FROM public.ecr.aws/docker/library/node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force

# ---------- Runtime ----------
FROM public.ecr.aws/docker/library/node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini wget \
 && addgroup -S app \
 && adduser  -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .

USER app

ENV NODE_ENV=production \
    PORT=3000

# EXPOSE is documentation only — actual port comes from $PORT at runtime.
EXPOSE 3000

# tini = proper PID 1, forwards SIGTERM so graceful shutdown in server.js works
ENTRYPOINT ["/sbin/tini", "--"]

# Default command = API server. The worker service overrides this in its ECS task definition:
#   ["node", "src/workers/processQueueWorker.js"]
CMD ["node", "server.js"]

# Container-level liveness probe — shell form so $PORT is resolved at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/live" || exit 1
