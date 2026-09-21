# Единый образ для любого тула. Тул не пишет свой Dockerfile.
# Контекст сборки — корень репозитория.
FROM node:22-bookworm-slim
ARG TOOL
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning

COPY package.json package-lock.json ./
COPY packages packages
COPY tools/${TOOL} tools/${TOOL}
RUN --mount=type=cache,target=/root/.npm,id=sandbox-npm \
    npm ci -w tools/${TOOL} -w packages/sdk -w packages/ui-kit -w packages/manifest --include-workspace-root --no-audit --no-fund \
 && if [ -f tools/${TOOL}/ui/app.tsx ]; then \
      npx esbuild tools/${TOOL}/ui/app.tsx --bundle --minify --format=esm \
        --jsx=automatic --jsx-import-source=preact --outfile=tools/${TOOL}/dist/app.js; \
    fi

ENV NODE_ENV=production
WORKDIR /app/tools/${TOOL}
USER node
EXPOSE 3000
HEALTHCHECK --interval=3s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.ts"]
