import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { JobManager, detectCapabilities } from 'fffleet';
import { close, createApiHandler, listen } from 'fffleet/server';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * A worker daemon: runs jobs on this machine and serves the fffleet job API.
 * With `orchestratorUrl` it registers itself and sends a heartbeat listing its active jobs.
 *
 * @param {object} [opts]
 * @param {string} [opts.id]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string | null} [opts.token]              Required from callers (the orchestrator or a client).
 * @param {Record<string, number> | string} [opts.slots]
 * @param {string} [opts.ffmpegPath]
 * @param {string} [opts.workRoot]
 * @param {string[]} [opts.extraCapabilities]       Added to the detected ones, e.g. 'mount:/data/media'.
 * @param {string | null} [opts.orchestratorUrl]
 * @param {string | null} [opts.orchestratorToken]  Worker token the orchestrator expects.
 * @param {string | null} [opts.advertiseUrl]       URL the orchestrator should call; defaults to the listen URL.
 * @param {number} [opts.heartbeatMs]
 * @param {number} [opts.progressIntervalMs]
 * @param {Record<string, Function>} [opts.executors]  Extra job types: type -> (spec, runtime) => Promise<result>.
 * @param {(msg: string) => void} [opts.log]
 */
export function createWorker({
  id = `worker-${hostname()}`,
  port = 5100,
  host = '0.0.0.0',
  token = null,
  slots = { default: 2 },
  ffmpegPath = 'ffmpeg',
  workRoot,
  extraCapabilities = [],
  orchestratorUrl = null,
  orchestratorToken = null,
  advertiseUrl = null,
  heartbeatMs = 5000,
  progressIntervalMs = 1000,
  executors = {},
  log = () => {},
} = {}) {
  const manager = new JobManager({ slots, ffmpegPath, workRoot, workerId: id, progressIntervalMs, executors });
  let capabilities = [];
  let server = null;
  let url = null;
  let heartbeat = null;
  let registered = false;

  const backend = {
    submit: spec => manager.submit(spec),
    get: jobId => manager.get(jobId),
    list: () => manager.list(),
    cancel: jobId => manager.cancel(jobId),
    writeStdin: (jobId, data) => manager.writeStdin(jobId, data),
    subscribe: (jobId, after, fn) => manager.subscribe(jobId, after, fn),
    capabilities: () => ({ id, version: VERSION, slots: manager.stats().pools, queued: manager.stats().queued, capabilities }),
  };

  async function register() {
    const res = await fetch(`${orchestratorUrl.replace(/\/+$/, '')}/v1/workers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(orchestratorToken ? { authorization: `Bearer ${orchestratorToken}` } : {}) },
      body: JSON.stringify({ id, url: advertiseUrl ?? url, slots: manager.slots, capabilities, version: VERSION, active: manager.activeIds() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`register returned HTTP ${res.status}`);
    if (!registered) log(`registered with ${orchestratorUrl} as ${id}`);
    registered = true;
  }

  function beat() {
    register().catch(err => {
      if (registered) log(`heartbeat to ${orchestratorUrl} failed: ${err.message}`);
      registered = false;
    });
  }

  return {
    id,
    manager,
    get url() {
      return url;
    },
    get capabilities() {
      return capabilities;
    },

    async start() {
      // type:ffmpeg comes from detection, so a machine without ffmpeg does not claim it.
      const types = Object.keys(manager.executors).filter(t => t !== 'ffmpeg').map(t => `type:${t}`);
      capabilities = [...new Set([...(await detectCapabilities(ffmpegPath)), ...types, ...extraCapabilities])].sort();
      ({ server, url } = await listen(createApiHandler({ backend, token }), { port, host }));
      log(`fffleet-worker ${id} listening on ${url} with slots ${JSON.stringify(manager.slots)}`);
      if (orchestratorUrl) {
        await register().catch(err => log(`first registration failed, retrying: ${err.message}`));
        heartbeat = setInterval(beat, heartbeatMs);
        heartbeat.unref?.();
      }
      return this;
    },

    /** Stops taking jobs, cancels running ones and closes the server. */
    async stop() {
      clearInterval(heartbeat);
      await manager.close();
      if (server) await close(server);
    },
  };
}
