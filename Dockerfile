# Coded by Aditya | GitHub- @adityatheog

# =============================================================================
# PanelKit — production container image
#
# A multi-stage build, for one specific reason: better-sqlite3 ships a native
# addon that must be compiled against the exact Node version and libc it will
# run on. Compiling needs python3, make and a C++ toolchain — around 300 MB of
# packages that have no business being in a running container. The build stage
# compiles; the runtime stage copies only the resulting node_modules.
#
# Notable decisions:
#
#   No port is exposed. The bot holds an outbound websocket to Discord and calls
#   the panel's REST API; it listens on nothing. Liveness is a file the process
#   rewrites every thirty seconds, read by scripts/healthcheck.js — so the
#   container needs no listening socket for monitoring either.
#
#   Runs as the unprivileged node user. The image's only writable location is the
#   data volume, and nothing in the container needs root.
#
#   No secrets are baked in. Credentials arrive as environment variables at run
#   time. A .env file copied into an image is a secret published to every
#   registry that mirrors it.
#
#   config.json is copied but expected to be overridden by a bind mount, so an
#   operator can change egg IDs without rebuilding.
#
# Build:
#   docker build -t panelkit-bot .
#
# Run:
#   docker run -d --name panelkit \
#     --env-file .env \
#     -v panelkit-data:/app/data \
#     -v "$(pwd)/config.json:/app/config.json:ro" \
#     --restart unless-stopped \
#     panelkit-bot
# =============================================================================


# -----------------------------------------------------------------------------
# Stage 1: build the native addon
# -----------------------------------------------------------------------------
# Pinned to a specific minor and to bookworm. Two reasons: a native addon
# compiled against one glibc must run against the same one, and an unpinned
# node:20 would silently change the compiler and the ABI between builds.
FROM node:20.18-bookworm-slim AS build

# python3, make and g++ are node-gyp's requirements for building better-sqlite3.
# Removed with the stage, so none of this reaches the final image.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes \
      python3 \
      make \
      g++ \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The manifest is copied alone so Docker caches the dependency layer. Source
# changes then rebuild in seconds rather than recompiling the addon every time.
COPY package.json ./
COPY package-lock.json* ./

# npm ci is reproducible and respects the lockfile exactly, which is what a
# production build wants. It requires a lockfile, so a fresh clone without one
# falls back to install.
#
# --omit=dev skips nothing here, since this project declares no devDependencies:
# the test runner is node:test and the checks are plain scripts. The flag is kept
# so the build stays correct if a dev dependency is ever added.
#
# --ignore-scripts is deliberately NOT used: better-sqlite3's install script is
# what compiles the addon.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      echo "No package-lock.json found; falling back to npm install." >&2; \
      npm install --omit=dev; \
    fi

# Prune npm's cache from the layer. The runtime stage copies only node_modules,
# so this is belt and braces for anyone who builds with this stage as a target.
RUN npm cache clean --force


# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:20.18-bookworm-slim AS runtime

# ca-certificates is required for TLS to the Discord gateway and to an https
# panel. The slim image does not include it.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # Absolute paths inside the container, so the working directory cannot change
    # where data lands. Both live on the volume declared below.
    DATABASE_PATH=/app/data/panelkit.sqlite \
    HEARTBEAT_PATH=/app/data/heartbeat \
    # npm's update notifier writes to a cache directory the node user may not own,
    # and produces noise in container logs.
    NO_UPDATE_NOTIFIER=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# The compiled dependency tree, including better-sqlite3's addon. Ownership is
# set during the copy rather than with a later chown, which would duplicate the
# whole layer.
COPY --from=build --chown=node:node /app/node_modules ./node_modules

# Application files. Copied individually rather than with a blanket COPY . so the
# image contains nothing incidental — no tests, no .git, no local .env even if
# .dockerignore were misconfigured.
COPY --chown=node:node package.json ./
COPY --chown=node:node config.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

# The data directory must exist and be writable before the process drops to the
# node user. When a named volume is mounted here Docker inherits this ownership;
# a host bind mount keeps the host's, which is why the README documents matching
# the uid.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Everything after this runs unprivileged. Nothing in the bot needs root, and the
# only writable path it requires is /app/data.
USER node

# Runtime state. Declaring it means an operator who forgets -v still gets a
# durable anonymous volume rather than losing the database with the container.
VOLUME ["/app/data"]

# Reads the heartbeat file and exits non-zero when it is stale or missing.
#
# start-period allows for the startup sequence: environment validation, database
# migration, and the optional panel credential check. The first heartbeat is
# written before the Discord login, so 40 seconds is generous.
#
# interval is 60s because the probe is cheap but not free, and a blocked event
# loop does not need sub-minute detection.
HEALTHCHECK --interval=60s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

# Node handles SIGTERM directly here because the CMD is exec form with no shell
# wrapper, so the process is PID 1 and receives signals unmodified. src/index.js
# installs a handler that stops timers, closes the gateway connection,
# checkpoints the WAL and removes the heartbeat file.
STOPSIGNAL SIGTERM

# No EXPOSE: the bot listens on nothing. Adding a port would advertise a surface
# that does not exist.

# Exec form, so node is PID 1 and there is no shell to swallow signals.
CMD ["node", "src/index.js"]
