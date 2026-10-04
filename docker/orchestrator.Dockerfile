# fffleet-orchestrator: Node.js only, no ffmpeg.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/fffleet/package.json packages/fffleet/
COPY packages/fffleet-worker/package.json packages/fffleet-worker/
COPY packages/fffleet-orchestrator/package.json packages/fffleet-orchestrator/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages/fffleet/src packages/fffleet/src
COPY packages/fffleet-orchestrator/src packages/fffleet-orchestrator/src
COPY packages/fffleet-orchestrator/bin packages/fffleet-orchestrator/bin

USER node
ENV NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0
EXPOSE 5000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/fffleet-orchestrator/bin/fffleet-orchestrator.js"]
