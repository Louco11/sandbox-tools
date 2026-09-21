# Деплоер: Node + git + Docker CLI (с buildx для RUN --mount в Dockerfile тулов).
# Контекст сборки — корень репозитория. Код выкатки берётся отсюда, а не из выкатываемой ветки.
FROM docker:28-cli AS docker-cli

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN npm init -y >/dev/null && npm pkg set type=module && npm install --no-audit --no-fund yaml@2.9.1 && npm cache clean --force
COPY charts/tool-base charts/tool-base
COPY infra/deployer infra/deployer
EXPOSE 8080
CMD ["node", "infra/deployer/deployer.ts"]
