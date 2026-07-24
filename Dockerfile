FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=7000 \
    HOST_ROOT=/host

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

EXPOSE 7000

CMD ["node", "server/index.js"]
