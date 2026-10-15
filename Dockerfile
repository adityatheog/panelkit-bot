ARG NODE_IMAGE=node:22.23.3-bookworm-slim
FROM ${NODE_IMAGE} AS build

RUN apt-get update \
 && apt-get install --no-install-recommends --yes \
      python3 \
      make \
      g++ \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./

RUN npm ci --omit=dev

RUN npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

RUN apt-get update \
 && apt-get install --no-install-recommends --yes ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/panelkit.sqlite \
    HEARTBEAT_PATH=/app/data/heartbeat \
    NO_UPDATE_NOTIFIER=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules

COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node config.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

STOPSIGNAL SIGTERM

CMD ["node", "src/index.js"]
