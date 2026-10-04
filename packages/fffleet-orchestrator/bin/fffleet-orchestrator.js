#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SCOPES, generateSecret, hashSecret } from 'fffleet';
import { createOrchestrator } from '../src/orchestrator.js';

const env = process.env;
const log = msg => console.log(`[fffleet-orchestrator] ${msg}`);

if (process.argv[2] === 'add-client') {
  await addClient(process.argv.slice(3));
  process.exit(0);
}

const orchestrator = createOrchestrator({
  port: Number(env.PORT ?? 5000),
  host: env.HOST ?? '0.0.0.0',
  token: env.FFFLEET_TOKEN || null,
  clients: env.FFFLEET_CLIENTS_FILE || null,
  signingKeyFile: env.FFFLEET_SIGNING_KEY_FILE || null,
  tokenTtlSeconds: Number(env.FFFLEET_TOKEN_TTL_SECONDS ?? 3600),
  workerToken: env.FFFLEET_WORKER_TOKEN || null,
  heartbeatTimeoutMs: Number(env.FFFLEET_HEARTBEAT_TIMEOUT_MS ?? 15000),
  maxQueued: Number(env.FFFLEET_MAX_QUEUED ?? 1000),
  log,
});

await orchestrator.start();
if (env.FFFLEET_CLIENTS_FILE && !env.FFFLEET_SIGNING_KEY_FILE) log('FFFLEET_SIGNING_KEY_FILE is not set: tokens stop working when the orchestrator restarts, and apps log in again');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    log(`${sig}: stopping`);
    await orchestrator.stop();
    process.exit(0);
  });
}

/**
 * fffleet-orchestrator add-client <id> [--scope jobs,metrics] [--file clients.json]
 * Adds (or replaces) an app in the clients file and prints its secret once.
 */
async function addClient(args) {
  const id = args[0];
  const opt = name => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = opt('file') ?? env.FFFLEET_CLIENTS_FILE;
  const scopes = (opt('scope') ?? 'jobs').split(',').map(s => s.trim()).filter(Boolean);
  if (!id || id.startsWith('--') || !file) {
    console.error('usage: fffleet-orchestrator add-client <id> [--scope jobs,metrics,admin] [--file clients.json]\n(the file defaults to FFFLEET_CLIENTS_FILE)');
    process.exit(2);
  }
  for (const s of scopes) {
    if (!SCOPES.includes(s)) {
      console.error(`unknown scope "${s}"; scopes are ${SCOPES.join(', ')}`);
      process.exit(2);
    }
  }
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { clients: [] };
  data.clients = (data.clients ?? []).filter(c => c.id !== id);
  const secret = generateSecret();
  data.clients.push({ id, secretHash: await hashSecret(secret), scopes });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  console.log(`client ${id} (${scopes.join(', ')}) written to ${file}`);
  console.log(`client secret (shown once): ${secret}`);
}
