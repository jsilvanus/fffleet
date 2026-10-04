#!/usr/bin/env node
import { createOrchestrator } from '../src/orchestrator.js';

const env = process.env;

const orchestrator = createOrchestrator({
  port: Number(env.PORT ?? 5000),
  host: env.HOST ?? '0.0.0.0',
  token: env.FFFLEET_TOKEN || null,
  workerToken: env.FFFLEET_WORKER_TOKEN || null,
  heartbeatTimeoutMs: Number(env.FFFLEET_HEARTBEAT_TIMEOUT_MS ?? 15000),
  maxQueued: Number(env.FFFLEET_MAX_QUEUED ?? 1000),
  log: msg => console.log(`[fffleet-orchestrator] ${msg}`),
});

await orchestrator.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    console.log(`[fffleet-orchestrator] ${sig}: stopping`);
    await orchestrator.stop();
    process.exit(0);
  });
}
