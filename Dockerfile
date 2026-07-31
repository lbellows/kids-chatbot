FROM node:24-slim

WORKDIR /app

# Install deps first for better layer caching. better-sqlite3 v13 ships N-API
# prebuilds for linux x64/arm64 (glibc and musl) inside its npm tarball, so this
# needs no compiler and makes no network call beyond the registry itself.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# The chat log lives on the mounted volume, never inside the image.
ENV DB_PATH=/data/chat.db

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
