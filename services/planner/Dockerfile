# Planner: todos, day plans, Google Calendar sync, 23:00/05:00 briefings and reminders.
# Built-in node:sqlite, no runtime dependencies.
FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm test && find dist -name '*.test.js*' -delete

FROM node:24-bookworm-slim
ENV TZ=America/Toronto NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY --from=build /build/dist /opt/planner
COPY package.json /opt/planner/package.json
RUN mkdir -p /var/lib/planner && chown node:node /var/lib/planner
USER node
EXPOSE 8091 8720
CMD ["node", "/opt/planner/main.js"]
