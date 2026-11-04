# Credential broker for Hermes: holds the controller delegator token, forwards a fixed API.
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm test && find dist -name '*.test.js*' -delete

FROM node:22-bookworm-slim
COPY --from=build /build/dist /opt/hermes-broker
COPY package.json /opt/hermes-broker/package.json
USER node
EXPOSE 8080
CMD ["node", "/opt/hermes-broker/main.js"]
