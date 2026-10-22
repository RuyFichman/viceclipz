FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /app/data && chown node:node /app/data
COPY --chown=node:node lib ./lib
COPY --chown=node:node dist ./dist
COPY --chown=node:node server.mjs worker.mjs automation-worker.mjs backup.mjs ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATA_DIR=/app/data FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
