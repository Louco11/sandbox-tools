# Главная страница песочницы. Контекст сборки — корень репозитория. npm-зависимостей нет, нужен только git.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY packages/ui-kit/src/styles.ts packages/ui-kit/src/styles.ts
COPY infra/agents/sync.ts infra/agents/sync.ts
COPY portal portal
USER node
EXPOSE 3000
CMD ["node", "portal/src/main.ts"]
