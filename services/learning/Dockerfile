# syntax=docker/dockerfile:1
# AI Learning OS service (L1). Holds only its own database; no controller, GitHub or worker credentials.

# ---- build: install all deps, compile, run the test suite, then drop dev deps
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src ./src
COPY test ./test
RUN npm run build \
 && npm test \
 && npm prune --omit=dev

# ---- runtime: compiled JS + production deps only, running as the unprivileged node user
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    LEARNING_DB_PATH=/var/lib/learning/learning.db
WORKDIR /app

# Owned by node so a fresh named volume mounted here inherits writable permissions.
RUN mkdir -p /var/lib/learning && chown node:node /var/lib/learning

# Application files stay root-owned: the app can read but not modify its own code.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
VOLUME ["/var/lib/learning"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/main.js"]
