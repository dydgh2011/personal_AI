
# ---- agent worker (polling client): compile and test with the same Node major as the runtime
FROM node:22-bookworm-slim AS agent-worker-build
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY services/worker/package.json services/worker/package-lock.json services/worker/.npmrc ./
RUN npm ci
COPY services/worker/tsconfig.json ./
COPY services/worker/src ./src
COPY services/worker/test-fixtures ./test-fixtures
RUN npm run build && npm test && \
    find dist -name '*.test.js*' -delete && rm -rf dist/testing

FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    @anthropic-ai/claude-code \
    @openai/codex

# Worker code has no runtime dependencies; root-owned so the agent user cannot change it.
COPY --from=agent-worker-build /build/dist /opt/agent-worker
COPY services/worker/package.json /opt/agent-worker/package.json
# Mount point of the publisher artifact volume; node-owned so a fresh named volume is writable.
RUN mkdir -p /artifacts && chown node:node /artifacts

USER node
ENV HOME=/home/node
WORKDIR /workspace

CMD ["sleep", "infinity"]
