FROM node:20-bookworm-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY --chown=node:node . .
ARG VITE_APP_VERSION=${VITE_APP_VERSION:-unknown}
ARG VITE_APP_COMMIT_HASH=${VITE_APP_COMMIT_HASH:-unknown}
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_COMMIT_HASH=$VITE_APP_COMMIT_HASH
RUN npm run build

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
