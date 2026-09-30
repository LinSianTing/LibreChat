# OpenSchool build recipe for branch openschool/main (see OPENSCHOOL.md).
#
# Same steps as the upstream ./Dockerfile, with two differences so it also builds where only
# Docker Hub and the npm registry are reachable (e.g. the OpenSchool cloud sandbox):
#   - Debian node image instead of alpine + apk (no Alpine package mirror needed; jemalloc dropped)
#   - no uv / ghcr.io stage (uv only serves extended MCP support, which OpenSchool does not use)
# The upstream ./Dockerfile stays untouched and remains the reference for production images.
FROM node:24.16.0-bookworm

ENV SCARF_ANALYTICS=false
ENV APP_TITLE=OpenSchool-Chat
ARG NODE_MAX_OLD_SPACE_SIZE=6144

RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node client/package.json ./client/package.json
COPY --chown=node:node packages/data-provider/package.json ./packages/data-provider/package.json
COPY --chown=node:node packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --chown=node:node packages/api/package.json ./packages/api/package.json

RUN touch .env ; \
    mkdir -p /app/client/public/images /app/logs /app/uploads /app/skill /app/data ; \
    chmod 1777 /app/data ; \
    npm config set fetch-retry-maxtimeout 600000 ; \
    npm config set fetch-retries 5 ; \
    npm config set fetch-retry-mintimeout 15000 ; \
    npm ci --no-audit

COPY --chown=node:node . .

RUN NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}" npm run frontend && \
    npm prune --production && \
    npm cache clean --force

ARG BUILD_COMMIT=
ARG BUILD_BRANCH=
ARG BUILD_DATE=
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_BRANCH=${BUILD_BRANCH}
ENV BUILD_DATE=${BUILD_DATE}

EXPOSE 3080
ENV HOST=0.0.0.0
CMD ["npm", "run", "backend"]
