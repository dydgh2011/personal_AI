# Isolated test runner (Phase E-2B). Runs admin-approved commands on one exact approved commit as an
# unprivileged sandbox user; signs the observed exit codes. Holds no GitHub or publisher credential.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Tests run as root here so the uid switch to the sandbox user is exercised for real.
RUN npm run build && npm test && find dist -name '*.test.js*' -delete

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 sandbox && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox \
 && mkdir -p /work /artifacts/claude /artifacts/codex /repo-exports
COPY --from=build /build/dist /opt/test-runner
COPY package.json /opt/test-runner/package.json
# The orchestrator runs as root with only CHOWN, SETUID, SETGID, KILL and DAC_READ_SEARCH (compose
# cap_add); test commands run as uid 10001 with none of them.
ENV HOME=/tmp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "process.exit(Date.now()-require('fs').statSync('/work/heartbeat').mtimeMs<120000?0:1)"]
CMD ["node", "/opt/test-runner/main.js"]
