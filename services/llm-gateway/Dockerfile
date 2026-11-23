# LLM gateway: the only holder of the AI provider keys. OpenAI-compatible, purpose aliases,
# free-tier quotas, fallbacks, paid approval, usage records (built-in node:sqlite, no dependencies).
FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm test && find dist -name '*.test.js*' -delete

FROM node:24-bookworm-slim
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY --from=build /build/dist /opt/llm-gateway
COPY package.json /opt/llm-gateway/package.json
RUN mkdir -p /var/lib/llm-gateway && chown node:node /var/lib/llm-gateway
USER node
EXPOSE 8094
CMD ["node", "/opt/llm-gateway/main.js"]
