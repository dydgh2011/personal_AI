# Read-only GitHub repository mirror. Holds no controller or GitHub credentials.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm test && find dist -name '*.test.js*' -delete

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /repo-cache /exports/claude /exports/codex /exports/publisher && chown -R node:node /repo-cache /exports
COPY --from=build /build/dist /opt/repo-sync
COPY package.json /opt/repo-sync/package.json
USER node
ENV REPO_CACHE_ROOT=/repo-cache
ENTRYPOINT ["node", "/opt/repo-sync/main.js"]
