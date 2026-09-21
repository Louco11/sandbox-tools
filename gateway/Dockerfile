# Контекст сборки — корень репозитория (npm workspaces).
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning

COPY package.json package-lock.json ./
COPY packages/manifest/package.json packages/manifest/
COPY gateway/package.json gateway/
RUN npm ci --omit=dev -w @sandbox/gateway -w @sandbox/manifest && npm cache clean --force

COPY packages/manifest packages/manifest
COPY gateway gateway

USER node
EXPOSE 8080
CMD ["node", "gateway/src/main.ts"]
