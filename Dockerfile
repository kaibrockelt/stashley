# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Stashley contributors
# SPDX-License-Identifier: AGPL-3.0-only

ARG NODE_IMAGE=node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=12.18.0
ENV CI=true
RUN npm install --global pnpm@${PNPM_VERSION} \
 && npm cache clean --force \
 && apt-get update \
 && apt-get install --yes --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm fetch --store-dir /pnpm-store

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm-store
RUN pnpm build \
 && pnpm --filter @stashley/server deploy --prod --legacy /out

# Typecheck, lint and unit tests; used by scripts/build.sh and the release workflow. The end-to-end
# suite and the documentation are not in the build context (.dockerignore); CI checks them.
FROM build AS check
RUN pnpm typecheck:app && pnpm lint && pnpm check:spdx && pnpm check:i18n && pnpm test && pnpm check:bundle

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=1970-01-01T00:00:00Z
LABEL org.opencontainers.image.title="Stashley" \
      org.opencontainers.image.description="Dashboards, forms and table views on MariaDB and MySQL databases" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/kaibrockelt/stashley"
ENV NODE_ENV=production \
    PORT=8080 \
    STASHLEY_DATA_DIR=/data \
    STASHLEY_WEB_DIR=/app/web \
    STASHLEY_VERSION=${VERSION}
WORKDIR /app
COPY --from=build /out /app/server
COPY --from=build /src/apps/web/dist /app/web
COPY apps/server/scripts/healthcheck.mjs /app/healthcheck.mjs
# npm is not needed at runtime; removing it shrinks the image and its attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && printf '#!/bin/sh\nexec node /app/server/dist/cli/index.js "$@"\n' > /usr/local/bin/stashley \
 && chmod 0755 /usr/local/bin/stashley \
 && mkdir -p /data \
 && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]
ENTRYPOINT ["stashley"]
CMD ["serve"]
