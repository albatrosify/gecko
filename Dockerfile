# Bun-based image (ADR 0003). `bun:sqlite` is built in, so there is no native
# module to compile — which is what made multi-arch builds slow before.
FROM oven/bun:1

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# `--ignore-scripts` skips better-sqlite3's native build. That module is only
# needed by the Node test path; under Bun the app uses the built-in `bun:sqlite`.
# esbuild's platform binary ships as a package (not a postinstall), so the
# frontend build below still works.
RUN bun install --ignore-scripts

COPY . .
ARG VITE_APP_VERSION=${VITE_APP_VERSION:-unknown}
ARG VITE_APP_COMMIT_HASH=${VITE_APP_COMMIT_HASH:-unknown}
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_COMMIT_HASH=$VITE_APP_COMMIT_HASH
ENV NODE_ENV=production
RUN bun run build

RUN mkdir -p /app/data && chown -R bun:bun /app/data

EXPOSE 3000

CMD ["bun", "server.ts"]
