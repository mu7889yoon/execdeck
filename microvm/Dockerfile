FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    WORKSPACE_ROOT=/workspace \
    HOME=/tmp \
    TMPDIR=/tmp

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash python3 make g++ \
  && npm ci --omit=dev --no-audit --no-fund \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY server.mjs ./server.mjs
COPY workspace /workspace
RUN chmod -R a+rX /app /workspace

EXPOSE 8080 8081
CMD ["node", "server.mjs"]
