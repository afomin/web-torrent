# Build stage has compilers so native modules also install on ARM (e.g. Oracle Ampere)
# when no prebuilt binary is available.
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ cmake ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV HOST=127.0.0.1 \
    PORT=3000 \
    DATA_DIR=/data \
    DOWNLOADS_DIR=/downloads

VOLUME ["/data", "/downloads"]
CMD ["node", "src/server.js"]
