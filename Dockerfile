FROM node:20-bullseye-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install MongoDB 4.4
RUN curl -fsSL https://www.mongodb.org/static/pgp/server-4.4.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/mongodb-archive-keyring.gpg] http://repo.mongodb.org/apt/ubuntu focal/mongodb-org/4.4 multiverse" | \
    tee /etc/apt/sources.list.d/mongodb-org-4.4.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    mongodb-org \
    && rm -rf /var/lib/apt/lists/*

# Create MongoDB data and log directories
RUN mkdir -p /data/db /var/log/mongodb && \
    chown -R node:node /data/db /var/log/mongodb

COPY --chown=node:node package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY --chown=node:node . .
ARG VITE_APP_VERSION=${VITE_APP_VERSION:-unknown}
ARG VITE_APP_COMMIT_HASH=${VITE_APP_COMMIT_HASH:-unknown}
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_COMMIT_HASH=$VITE_APP_COMMIT_HASH
RUN npm run build

# Copy entrypoint script and make it executable
COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV CACHE_DIR=/app/data/cache
RUN mkdir -p $CACHE_DIR && chown -R node:node /app/data

EXPOSE 3000

ENTRYPOINT ["entrypoint.sh"]
CMD ["npx", "tsx", "server.ts"]
