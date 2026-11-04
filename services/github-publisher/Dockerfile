# GitHub Publisher (Phase E-2B). Holds its controller token and the test evidence key; no GitHub credential configured yet.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm test && find dist \( -name '*.test.js*' -o -name 'testkit.js*' \) -delete

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/publisher /artifacts/claude /artifacts/codex /repo-exports \
 && chown node:node /var/lib/publisher
# Code is root-owned: the publisher can read but not change itself.
COPY --from=build /build/dist /opt/publisher
COPY package.json /opt/publisher/package.json
USER node
ENV HOME=/tmp
VOLUME ["/var/lib/publisher"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "process.exit(Date.now()-require('fs').statSync('/tmp/publisher/heartbeat').mtimeMs<120000?0:1)"]
CMD ["node", "/opt/publisher/main.js"]
