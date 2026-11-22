# Knowledge store: raw originals, activity timeline, wiki pages, profile; keyword + semantic search.
# Built-in node:sqlite (FTS5) + sqlite-vec (vector search).
FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm test && find dist -name '*.test.js*' -delete

FROM node:24-bookworm-slim
ENV TZ=America/Toronto NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /opt/knowledge
# Runtime dependency: sqlite-vec (prebuilt loadable extension; install scripts are off in .npmrc).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist /opt/knowledge
# uid 10000 = the Hermes user: Hermes keeps chat attachments owner-only (0700), and the knowledge
# service reads them (read-only mount) to keep the originals. Not root.
RUN mkdir -p /var/lib/knowledge && chown 10000:10000 /var/lib/knowledge
USER 10000:10000
EXPOSE 8092
CMD ["node", "/opt/knowledge/main.js"]
