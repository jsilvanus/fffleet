#!/usr/bin/env node
import { s3ConfigFromEnv } from 'fffleet';
import { createWorker } from '../src/worker.js';

const env = process.env;
const list = v => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

const worker = createWorker({
  id: env.FFFLEET_WORKER_ID || undefined,
  port: Number(env.PORT ?? 5100),
  host: env.HOST ?? '0.0.0.0',
  // Behind an orchestrator the worker usually accepts the same token it registers with.
  token: env.FFFLEET_TOKEN || env.FFFLEET_WORKER_TOKEN || null,
  slots: env.FFFLEET_SLOTS || 'default=2',
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  workRoot: env.FFFLEET_WORK_DIR || undefined,
  extraCapabilities: list(env.FFFLEET_CAPABILITIES),
  orchestratorUrl: env.FFFLEET_ORCHESTRATOR_URL || null,
  orchestratorToken: env.FFFLEET_WORKER_TOKEN || null,
  advertiseUrl: env.FFFLEET_ADVERTISE_URL || null,
  heartbeatMs: Number(env.FFFLEET_HEARTBEAT_MS ?? 5000),
  s3: s3ConfigFromEnv(env),
  log: msg => console.log(`[fffleet-worker] ${msg}`),
});

await worker.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    console.log(`[fffleet-worker] ${sig}: stopping`);
    await worker.stop();
    process.exit(0);
  });
}
