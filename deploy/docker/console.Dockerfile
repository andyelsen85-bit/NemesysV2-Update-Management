FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PORT=19533
ENV BASE_PATH=/
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/nemesys-console run build

FROM nginx:1.27-alpine AS runtime

RUN apk add --no-cache openssl inotify-tools

COPY deploy/docker/nginx-console.conf /etc/nginx/conf.d/default.conf
COPY deploy/docker/nginx-console-entrypoint.sh /usr/local/bin/nemesys-console
COPY --from=build /workspace/artifacts/nemesys-console/dist/public /usr/share/nginx/html

RUN chmod 0755 /usr/local/bin/nemesys-console

EXPOSE 80 443
ENTRYPOINT ["/usr/local/bin/nemesys-console"]