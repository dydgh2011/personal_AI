# syntax=docker/dockerfile:1

# ---- build: install deps, typecheck, run unit tests, build the standalone server
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json next.config.mjs vitest.config.mts next-env.d.ts server-entry.cjs ./
COPY src ./src
COPY test ./test
# next-env.d.ts references generated route types, so the standalone typecheck runs after the build.
RUN npm test \
 && npm run build \
 && npm run typecheck

# ---- runtime: the standalone server only (no dev deps, no sources), unprivileged user
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DASHBOARD_AUDIT_LOG=/var/lib/dashboard/audit.log
WORKDIR /app

# Owned by node so a fresh named volume mounted here inherits writable permissions.
RUN mkdir -p /var/lib/dashboard && chown node:node /var/lib/dashboard

# Application files stay root-owned: the app can read but not modify its own code.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/server-entry.cjs ./

USER node
EXPOSE 3000
VOLUME ["/var/lib/dashboard"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# server-entry.cjs decides the client address from the TCP peer, then starts server.js.
CMD ["node", "server-entry.cjs"]
