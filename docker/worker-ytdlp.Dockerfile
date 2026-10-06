# fffleet-worker-ytdlp: the worker image plus yt-dlp and the built-in `download` executor (type:download).
# Same as worker.Dockerfile, with python3 + yt-dlp and FFFLEET_EXECUTORS set.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core ca-certificates python3 python3-pip \
 && python3 -m pip install --break-system-packages yt-dlp \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -hide_banner -filters | grep -qE '^ \S{3} ass ' \
 && ffmpeg -hide_banner -filters | grep -qE '^ \S{3} drawtext ' \
 && ffmpeg -hide_banner -encoders | grep -q libx264 \
 && yt-dlp --version

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/fffleet/package.json packages/fffleet/
COPY packages/fffleet-worker/package.json packages/fffleet-worker/
COPY packages/fffleet-orchestrator/package.json packages/fffleet-orchestrator/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages/fffleet/src packages/fffleet/src
COPY packages/fffleet-worker/src packages/fffleet-worker/src
COPY packages/fffleet-worker/bin packages/fffleet-worker/bin

RUN mkdir -p /var/lib/fffleet && chown node:node /var/lib/fffleet
USER node
ENV NODE_ENV=production \
    PORT=5100 \
    HOST=0.0.0.0 \
    FFFLEET_WORK_DIR=/var/lib/fffleet \
    FFFLEET_EXECUTORS=/app/packages/fffleet-worker/src/executors/download.js
EXPOSE 5100
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/fffleet-worker/bin/fffleet-worker.js"]
