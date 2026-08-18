# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci && npm rebuild sqlite3 --build-from-source
COPY tsconfig.base.json tsconfig.server.json vitest.config.ts ./
COPY src ./src
COPY ui ./ui
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOME=/tmp
RUN groupadd --gid 10001 refract && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin refract
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
USER 10001:10001
EXPOSE 8340 8341
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8341/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/server/src/entrypoint.js"]
