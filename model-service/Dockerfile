# API Mender model gateway image.
#
# Contains Node and two source files; no npm install, no build step, no shell
# entrypoint. Pin the base image by digest in production
# (node:22-alpine@sha256:...) so rebuilds are reproducible.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Only gateway/ is copied (see .dockerignore: tests are excluded). Files are
# owned by root and the process runs as `node`, so the running gateway cannot
# modify its own code even without a read-only root filesystem.
COPY --chown=root:root gateway/ ./gateway/

USER node
EXPOSE 8787

# busybox wget is in the base image; /healthz is unauthenticated and static.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/healthz || exit 1

# Exec form: node is PID 1 and receives SIGTERM directly for graceful shutdown.
ENTRYPOINT ["node", "gateway/server.mjs"]
