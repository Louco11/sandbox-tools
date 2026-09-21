# Коннектор источников postgres стенда. Один образ, экземпляр — на источник (SOURCE). Контекст — корень репозитория.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning

COPY package.json package-lock.json ./
COPY connectors/postgres/package.json connectors/postgres/
RUN npm ci --omit=dev -w @sandbox/connector-postgres --no-audit --no-fund && npm cache clean --force

COPY packages/connector packages/connector
COPY connectors/postgres connectors/postgres

USER node
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "connectors/postgres/src/server.ts"]
