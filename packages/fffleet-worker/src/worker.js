import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { JobManager, detectCapabilities } from 'fffleet';
import {
  Registry, close, createApiHandler, createAuthenticator, createRemoteKeySet, createTokenVerifier,
  hostMetrics, jobMetrics, listen, procStats, processMetrics,
} from 'fffleet/server';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * A worker daemon: runs jobs on this machine and serves the fffleet job API.
 * With `orchestratorUrl` it registers itself and sends a heartbeat listing its active jobs.
 *
 * @param {object} [opts]
 * @param {string} [opts.id]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string | null} [opts.token]              Static token that is granted full access (the orchestrator sends it).
 * @param {string | null} [opts.keysUrl]            An orchestrator's /v1/auth/keys: tokens it issued are accepted too, with their scopes.
 * @param {Record<string, number> | string} [opts.slots]   Pools, or 'auto' / 'auto:<cores per job>' to size them from the CPU count.
 * @param {('batch' | 'stream')[] | string} [opts.kinds]   Job kinds this worker takes; both by default. A batch-only and a stream-only worker keep long streams from starving encodes.
 * @param {string} [opts.ffmpegPath]
 * @param {string} [opts.workRoot]
 * @param {string[]} [opts.extraCapabilities]       Added to the detected ones, e.g. 'mount:/data/media'.
 * @param {string | null} [opts.orchestratorUrl]
 * @param {string | null} [opts.orchestratorToken]  Worker token the orchestrator expects.
 * @param {string | null} [opts.advertiseUrl]       URL the orchestrator should call; defaults to the listen URL.
 * @param {number} [opts.heartbeatMs]
 * @param {number} [opts.progressIntervalMs]
 * @param {Record<string, Function>} [opts.executors]  Extra job types: type -> (spec, runtime) => Promise<result>.
 * @param {object | null} [opts.s3]                   S3 settings (see s3ConfigFromEnv); adds the scheme:s3 capability.
 * @param {(msg: string) => void} [opts.log]
 */
export function createWorker({
  id = `worker-${hostname()}`,
  port = 5100,
  host = '0.0.0.0',
  token = null,
  keysUrl = null,
  slots = { default: 2 },
  kinds = undefined,
  ffmpegPath = 'ffmpeg',
  workRoot,
  extraCapabilities = [],
  orchestratorUrl = null,
  orchestratorToken = null,
  advertiseUrl = null,
  heartbeatMs = 5000,
  progressIntervalMs = 1000,
  executors = {},
  s3 = null,
  log = () => {},
} = {}) {
  const manager = new JobManager({ slots, kinds, ffmpegPath, workRoot, workerId: id, progressIntervalMs, executors, s3 });
  let capabilities = [];
  let server = null;
  let url = null;
  let heartbeat = null;
  let registered = false;

  const authenticate = createAuthenticator({
    token,
    verify: keysUrl ? createTokenVerifier({ getKey: createRemoteKeySet(keysUrl) }) : null,
    open: !token && !keysUrl,
  });

  const registry = new Registry();
  processMetrics(registry);
  hostMetrics(registry, manager.workRoot);
  const jobStats = jobMetrics(registry, () => manager.jobs.values());
  manager.on('job', record => jobStats.track(record));
  const slotsTotal = registry.gauge('fffleet_slots', 'Slots per pool.', ['pool']);
  const slotsUsed = registry.gauge('fffleet_slots_used', 'Slots in use per pool.', ['pool']);
  const queued = registry.gauge('fffleet_queue_length', 'Jobs waiting for a slot on this worker.');
  const speed = registry.gauge('fffleet_job_speed', 'Encoding speed of a running job as a multiple of real time.', ['job', 'owner', 'class']);
  const fps = registry.gauge('fffleet_job_fps', 'Frames per second of a running job.', ['job', 'owner', 'class']);
  const procCpu = registry.gauge('fffleet_ffmpeg_cpu_seconds', 'CPU time used so far by a running ffmpeg process (Linux).', ['job']);
  const procRss = registry.gauge('fffleet_ffmpeg_resident_memory_bytes', 'Resident memory of a running ffmpeg process (Linux).', ['job']);
  const transferred = registry.counter('fffleet_transfer_bytes_total', 'Bytes staged in and uploaded out of this worker.', ['direction', 'scheme']);
  const info = registry.gauge('fffleet_build_info', 'Version of this fffleet process.', ['role', 'version', 'worker']);
  info.set({ role: 'worker', version: VERSION, worker: id }, 1);
  manager.on('transfer', t => transferred.inc({ direction: t.direction, scheme: t.scheme }, t.bytes));
  registry.collect(async () => {
    for (const g of [slotsTotal, slotsUsed, speed, fps, procCpu, procRss]) g.reset();
    const stats = manager.stats();
    for (const [pool, p] of Object.entries(stats.pools)) {
      slotsTotal.set({ pool }, p.total);
      slotsUsed.set({ pool }, p.used);
    }
    queued.set({}, stats.queued);
    for (const r of manager.jobs.values()) {
      if (r.state !== 'running') continue;
      const l = { job: r.id, owner: r.spec.owner, class: r.spec.class };
      if (r.progress?.speed != null) speed.set(l, r.progress.speed);
      if (r.progress?.fps != null) fps.set(l, r.progress.fps);
      const ps = r.run?.pid ? await procStats(r.run.pid) : null;
      if (ps) {
        procCpu.set({ job: r.id }, ps.cpuSeconds);
        procRss.set({ job: r.id }, ps.rssBytes);
      }
    }
  });

  const backend = {
    submit: spec => manager.submit(spec),
    get: jobId => manager.get(jobId),
    list: () => manager.list(),
    cancel: jobId => manager.cancel(jobId),
    writeStdin: (jobId, data) => manager.writeStdin(jobId, data),
    subscribe: (jobId, after, fn) => manager.subscribe(jobId, after, fn),
    capabilities: () => ({ id, version: VERSION, kinds: manager.kinds, slots: manager.stats().pools, queued: manager.stats().queued, capabilities }),
  };

  async function register() {
    const res = await fetch(`${orchestratorUrl.replace(/\/+$/, '')}/v1/workers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(orchestratorToken ? { authorization: `Bearer ${orchestratorToken}` } : {}) },
      body: JSON.stringify({ id, url: advertiseUrl ?? url, slots: manager.slots, kinds: manager.kinds, capabilities, version: VERSION, active: manager.activeIds() }),
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
    registry,
    get url() {
      return url;
    },
    get capabilities() {
      return capabilities;
    },

    async start() {
      // type:ffmpeg comes from detection, so a machine without ffmpeg does not claim it.
      const types = Object.keys(manager.executors).filter(t => t !== 'ffmpeg').map(t => `type:${t}`);
      const schemes = manager.s3 ? ['scheme:s3'] : [];
      capabilities = [...new Set([...(await detectCapabilities(ffmpegPath)), ...types, ...schemes, ...extraCapabilities])].sort();
      ({ server, url } = await listen(createApiHandler({ backend, authenticate, metrics: () => registry.render() }), { port, host }));
      log(`fffleet-worker ${id} listening on ${url} with slots ${JSON.stringify(manager.slots)} for ${manager.kinds.join(' and ')} jobs`);
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
