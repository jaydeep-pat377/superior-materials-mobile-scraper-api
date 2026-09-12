FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini wget
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production PORT=5000
EXPOSE 5000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-5000}/health" || exit 1
