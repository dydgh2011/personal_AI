# Notifier: the only service holding the Discord webhook. Typed events in, fixed templates out.
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm test && find dist -name '*.test.js*' -delete

FROM node:22-bookworm-slim
COPY --from=build /build/dist /opt/notifier
COPY package.json /opt/notifier/package.json
RUN mkdir -p /var/lib/notifier && chown node:node /var/lib/notifier
USER node
EXPOSE 8090
CMD ["node", "/opt/notifier/main.js"]
