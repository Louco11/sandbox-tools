# Личность песочницы: OIDC-клиент к IdP и ForwardAuth для Traefik. Контекст сборки — корень репозитория.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json package-lock.json ./
COPY packages/manifest/package.json packages/manifest/package.json
COPY infra/identity/package.json infra/identity/package.json
RUN npm ci --omit=dev --workspace @sandbox/identity --include-workspace-root
COPY packages/manifest packages/manifest
COPY infra/identity infra/identity
# Пишем ключ подписи в том /state — остаёмся root, как деплоер и уведомления.
EXPOSE 8080
CMD ["node", "infra/identity/src/main.ts"]
