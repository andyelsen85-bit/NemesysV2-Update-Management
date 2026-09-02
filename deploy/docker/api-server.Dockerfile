FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

RUN groupadd --system --gid 10001 nemesys \
  && useradd --system --uid 10001 --gid 10001 --home-dir /app nemesys

COPY --from=build --chown=nemesys:nemesys /workspace/artifacts/api-server/dist ./dist

USER nemesys
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]