# syntax=docker/dockerfile:1

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
    CONTROLLER_DB_PATH=/var/lib/controller/controller.db
WORKDIR /app

# Owned by node so a fresh named volume mounted here inherits writable permissions.
RUN mkdir -p /var/lib/controller && chown node:node /var/lib/controller

# Application files stay root-owned: the app can read but not modify its own code.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
VOLUME ["/var/lib/controller"]

CMD ["node", "--enable-source-maps", "dist/main.js"]
