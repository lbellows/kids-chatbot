FROM node:24-slim

WORKDIR /app

# Install deps first for better layer caching.
#
# --ignore-scripts is required, not just tidy. better-sqlite3 v13 ships N-API
# prebuilds for linux x64/arm64 (glibc and musl) inside its npm tarball and
# picks the right one at require time. But it also ships a binding.gyp, and npm
# *defaults* to running `node-gyp rebuild` for any package that has one and
# declares no install script of its own. That default tries to compile from
# source, which fails here because slim images carry no Python or toolchain —
# and would be a waste even if it succeeded, since the prebuilt binary is right
# there. Skipping scripts uses the prebuild and keeps the image compiler-free.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# The chat log lives on the mounted volume, never inside the image.
ENV DB_PATH=/data/chat.db

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
