FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Native SQLite can fall back to compilation when a prebuilt binary is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/kindling.db \
    KINDLING_EMBEDDED_WORKER=false

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/lib/db/migrations ./lib/db/migrations
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/scripts/start.mjs /app/scripts/healthcheck.mjs ./scripts/

RUN mkdir -p /app/data /watched-books && chown node:node /app/data /watched-books
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=8s --start-period=45s --retries=3 \
    CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "scripts/start.mjs"]
