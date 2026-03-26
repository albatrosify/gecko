FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY . .
ARG VITE_APP_VERSION=unknown
ENV VITE_APP_VERSION=$VITE_APP_VERSION
RUN npm run build

ENV CACHE_DIR=/app/data/cache

EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
