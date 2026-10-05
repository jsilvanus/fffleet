import { readFileSync } from 'node:fs';
import { createAutoscaler } from './autoscaler.js';
import { createProviders } from './providers/index.js';
import { randomUUID } from 'node:crypto';
import { FleetError, JobRecord, byPriority, canonicalJson, followJobEvents, implicitRequirements, normalizeKinds, normalizeSlots, parseSpec, pruneFinished, satisfies } from 'fffleet';
import {
  Registry, allowed, checkBearer, close, createApiHandler, createAuthenticator, createClientStore, createTokenSigner, createTokenVerifier,
  bearerOf, getStream, issueToken, jobMetrics, listen, loadSigningKey, processMetrics, readBody, readJson, send, sendError,
} from 'fffleet/server';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const REDISPATCH_DELAY_MS = 500;

/**
 * The orchestrator: one job API in front of many workers. It queues jobs by priority, sends each
 * to a worker with a free slot in the job's class and the capabilities it requires, relays the
 * worker's events, and fails jobs whose worker stops sending heartbeats.
 *
 * State is in memory: a restart forgets queued and running jobs (workers keep running theirs).
 *
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string | null} [opts.token]          Static bearer token with full (admin) access.
 * @param {string | object[] | null} [opts.clients]  Apps that may log in: a clients file path, or a list of { id, secretHash, scopes }.
 * @param {import('node:crypto').KeyObject | string | null} [opts.signingKey]  Ed25519 key for tokens (KeyObject or PEM).
 * @param {string | null} [opts.signingKeyFile] Where the signing key is kept; created when missing. Without it tokens die with the process.
 * @param {number} [opts.tokenTtlSeconds]
 * @param {{ publicUrl: string | null, autoscale: object, pools: object[] } | null} [opts.scaling]  Where to start more workers (see loadConfig). Without it the pool is whatever registers.
 * @param {Record<string, object>} [opts.providers]   Provider instances by pool name, replacing the built-in ones (tests).
 * @param {Buffer | string | null} [opts.joinKey]    Key the workers' join secrets derive from. Default: the signing key's file contents, else random.
 * @param {string | null} [opts.workerToken]    Bearer token workers register with; also sent to workers.
 * @param {number} [opts.heartbeatTimeoutMs]    A worker silent this long is dropped and its jobs fail.
 * @param {number} [opts.sweepMs]
 * @param {number} [opts.maxQueued]
 * @param {number} [opts.keepFinished]          Finished jobs remembered for status and idempotency.
 * @param {number} [opts.lostJobGraceMs]        How long a dispatched job may be missing from a heartbeat.
 * @param {number} [opts.dispatchCooldownMs]    How long a worker that answered a dispatch with 5xx gets no new jobs.
 * @param {(msg: string) => void} [opts.log]
 */
export function createOrchestrator({
  port = 5000,
  host = '0.0.0.0',
  token = null,
  clients = null,
  signingKey = null,
  signingKeyFile = null,
  tokenTtlSeconds = 3600,
  scaling = null,
  providers: providerOverrides = {},
  joinKey = null,
  workerToken = null,
  heartbeatTimeoutMs = 15000,
  sweepMs = 1000,
  maxQueued = 1000,
  keepFinished = 1000,
  lostJobGraceMs = 10000,
  dispatchCooldownMs = 5000,
  log = () => {},
} = {}) {
  /** @type {Map<string, Worker>} */
  const workers = new Map();
  /** @type {Map<string, Job>} */
  const jobs = new Map();
  /** @type {Job[]} */
  const queue = [];
  let server = null;
  let url = null;
  let sweeper = null;
  let pumpTimer = null;

  // The key the workers' join secrets derive from: stable across restarts only when the signing key is a file.
  const signingKeyBytes = () => {
    try {
      return signingKeyFile ? readFileSync(signingKeyFile) : null;
    } catch {
      return null;
    }
  };
  const clientStore = createClientStore(clients);
  const signer = createTokenSigner({ privateKey: signingKey ?? loadSigningKey(signingKeyFile), ttlSeconds: tokenTtlSeconds });
  const authenticate = createAuthenticator({
    token,
    verify: clientStore ? createTokenVerifier({ getKey: kid => (kid === signer.kid ? signer.publicKey : null) }) : null,
    isActive: sub => clientStore?.has(sub) ?? false,
  });

  let autoscaler = null;
  const registry = new Registry();
  processMetrics(registry);
  const jobStats = jobMetrics(registry, () => jobs.values());
  const m = {
    info: registry.gauge('fffleet_build_info', 'Version of this fffleet process.', ['role', 'version']),
    workerSlots: registry.gauge('fffleet_worker_slots', 'Slots per worker and pool.', ['worker', 'pool']),
    workerUsed: registry.gauge('fffleet_worker_slots_used', 'Slots in use per worker and pool.', ['worker', 'pool']),
    workerAge: registry.gauge('fffleet_worker_heartbeat_age_seconds', 'Seconds since the worker last registered or sent a heartbeat.', ['worker']),
    workerDraining: registry.gauge('fffleet_worker_draining', '1 while the worker is drained.', ['worker']),
    workerCooldown: registry.gauge('fffleet_worker_cooldown', '1 while the worker gets no new jobs after a failed dispatch.', ['worker']),
    workers: registry.gauge('fffleet_workers', 'Registered workers.'),
    queued: registry.gauge('fffleet_queue_length', 'Jobs waiting for a worker, by class.', ['class']),
    dispatchFailures: registry.counter('fffleet_dispatch_failures_total', 'Dispatches a worker did not accept.', ['worker', 'reason']),
    workersLost: registry.counter('fffleet_workers_lost_total', 'Workers dropped after missing their heartbeats.'),
    tokensIssued: registry.counter('fffleet_auth_tokens_issued_total', 'Tokens issued, by client.', ['client']),
    loginFailures: registry.counter('fffleet_auth_login_failures_total', 'Token requests refused, by OAuth2 error.', ['error']),
  };
  m.info.set({ role: 'orchestrator', version: VERSION }, 1);
  const scaleMetrics = {
    instances: registry.gauge('fffleet_autoscaler_instances', 'Workers the autoscaler manages, by pool and state.', ['pool', 'state']),
    creates: registry.counter('fffleet_autoscaler_creates_total', 'Workers the autoscaler tried to start.', ['pool', 'result']),
    destroys: registry.counter('fffleet_autoscaler_destroys_total', 'Workers the autoscaler removed, by reason.', ['pool', 'reason']),
  };
  registry.collect(() => {
    for (const g of [m.workerSlots, m.workerUsed, m.workerAge, m.workerDraining, m.workerCooldown, m.queued]) g.reset();
    const now = Date.now();
    for (const w of workers.values()) {
      for (const [pool, total] of Object.entries(w.slots)) {
        m.workerSlots.set({ worker: w.id, pool }, total);
        m.workerUsed.set({ worker: w.id, pool }, w.used[pool] ?? 0);
      }
      m.workerAge.set({ worker: w.id }, (now - w.lastSeen) / 1000);
      m.workerDraining.set({ worker: w.id }, w.draining ? 1 : 0);
      m.workerCooldown.set({ worker: w.id }, w.cooldownUntil > now ? 1 : 0);
    }
    m.workers.set({}, workers.size);
    for (const job of queue) m.queued.inc({ class: job.spec.class });
  });

  /**
   * @typedef {{ id: string, url: string, slots: Record<string, number>, used: Record<string, number>, kinds: string[], token: string | null,
   *   capabilities: Set<string>, version: string | null, lastSeen: number, draining: boolean, cooldownUntil: number, jobs: Set<string> }} Worker
   * @typedef {JobRecord & { worker?: Worker | null, pool?: string, follow?: AbortController, assignedAt?: number, released?: boolean }} Job
   */

  // A worker is called with the token it registered with: the shared worker token, or its own join secret.
  const workerHeaders = (worker, extra = {}) => {
    const t = worker?.token ?? workerToken;
    return { ...extra, ...(t ? { authorization: `Bearer ${t}` } : {}) };
  };

  function poolFor(worker, cls) {
    return worker.slots[cls] !== undefined ? cls : 'default';
  }

  function fits(worker, job) {
    if (worker.draining || worker.cooldownUntil > Date.now()) return false;
    if (!worker.kinds.includes(job.spec.kind)) return false;
    const pool = poolFor(worker, job.spec.class);
    const total = worker.slots[pool] ?? 0;
    return total > 0 && (worker.used[pool] ?? 0) < total
      && satisfies(worker.capabilities, implicitRequirements(job.spec)) && satisfies(worker.capabilities, job.spec.requires);
  }

  function load(worker) {
    const total = Object.values(worker.slots).reduce((a, b) => a + b, 0) || 1;
    return Object.values(worker.used).reduce((a, b) => a + b, 0) / total;
  }

  function pump() {
    for (const job of [...queue]) {
      const candidates = [...workers.values()].filter(w => fits(w, job)).sort((a, b) => load(a) - load(b));
      if (!candidates.length) continue;
      queue.splice(queue.indexOf(job), 1);
      dispatch(job, candidates[0]);
    }
  }

  function schedulePump(delay = 0) {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, delay);
    pumpTimer.unref?.();
  }

  function enqueue(job) {
    queue.push(job);
    queue.sort(byPriority);
  }

  async function dispatch(job, worker) {
    const pool = poolFor(worker, job.spec.class);
    worker.used[pool] = (worker.used[pool] ?? 0) + 1;
    worker.jobs.add(job.id);
    job.worker = worker;
    job.pool = pool;
    job.released = false;
    job.assignedAt = Date.now();
    job.push({ state: 'assigned', workerId: worker.id });

    let res;
    try {
      res = await fetch(`${worker.url}/v1/jobs`, {
        method: 'POST',
        headers: workerHeaders(worker, { 'content-type': 'application/json' }),
        body: JSON.stringify(job.spec),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      log(`dispatch of ${job.id} to ${worker.id} failed: ${err.message}; dropping the worker until it re-registers`);
      m.dispatchFailures.inc({ worker: worker.id, reason: 'unreachable' });
      return redispatch(job, worker);
    }
    if (job.final) return release(job); // cancelled while dispatching; the cancel already reached the worker or will be ignored
    if (res.status >= 500) {
      log(`worker ${worker.id} answered ${res.status} for ${job.id}; trying elsewhere`);
      worker.cooldownUntil = Date.now() + dispatchCooldownMs;
      m.dispatchFailures.inc({ worker: worker.id, reason: 'server_error' });
      return redispatch(job, worker, false);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      m.dispatchFailures.inc({ worker: worker.id, reason: 'rejected' });
      job.push({ state: 'failed', error: { code: 'DISPATCH_REJECTED', message: `worker ${worker.id} rejected the job: ${body?.error?.message ?? `HTTP ${res.status}`}` } });
      return release(job);
    }
    follow(job, worker);
  }

  /** Puts a job back in the queue after its worker could not take it. */
  function redispatch(job, worker, dropWorker = true) {
    release(job, false);
    if (dropWorker) removeWorker(worker, null);
    if (job.final) return;
    job.push({ state: 'queued', workerId: null });
    enqueue(job);
    schedulePump(REDISPATCH_DELAY_MS);
  }

  function follow(job, worker) {
    const ac = new AbortController();
    job.follow = ac;
    followJobEvents({
      url: `${worker.url}/v1/jobs/${encodeURIComponent(job.id)}/events`,
      headers: () => workerHeaders(worker),
      signal: ac.signal,
      maxRetries: 3,
      onEvent: e => {
        if (e.state === 'queued' && !e.progress) return;
        job.push({
          state: e.state === 'queued' ? job.state : e.state,
          workerId: worker.id,
          ...(e.progress ? { progress: e.progress } : {}),
          ...(['succeeded', 'failed', 'cancelled'].includes(e.state)
            ? { exitCode: e.exitCode ?? null, error: e.error, outputs: e.outputs ?? [], stderrTail: e.stderrTail ?? null }
            : {}),
        });
      },
    })
      .catch(err => {
        if (ac.signal.aborted || job.final) return;
        job.push({ state: 'failed', error: { code: 'WORKER_LOST', message: `lost the event stream from worker ${worker.id}: ${err.message}` } });
      })
      .finally(() => release(job));
  }

  function release(job, pumpAfter = true) {
    if (job.released || !job.worker) return;
    job.released = true;
    const w = job.worker;
    w.used[job.pool] = Math.max(0, (w.used[job.pool] ?? 1) - 1);
    w.jobs.delete(job.id);
    job.follow?.abort();
    if (pumpAfter) schedulePump();
  }

  /** Removes a worker. With `reason`, its unfinished jobs fail with that error. */
  function removeWorker(worker, reason) {
    if (workers.get(worker.id) !== worker) return;
    workers.delete(worker.id);
    for (const id of [...worker.jobs]) {
      const job = jobs.get(id);
      if (!job) continue;
      if (reason && !job.final) job.push({ state: 'failed', error: reason });
      if (reason) release(job, false);
    }
    log(`worker ${worker.id} removed${reason ? `: ${reason.message}` : ''}`);
  }

  function register(body, bearer = null) {
    if (!body || typeof body.id !== 'string' || !body.id || typeof body.url !== 'string') {
      throw new FleetError('INVALID_WORKER', 'register needs id and url', { status: 400 });
    }
    let slots;
    try {
      slots = normalizeSlots(body.slots ?? { default: 1 });
    } catch (err) {
      throw new FleetError('INVALID_WORKER', err.message, { status: 400 });
    }
    let kinds;
    try {
      kinds = normalizeKinds(body.kinds);
    } catch (err) {
      throw new FleetError('INVALID_WORKER', err.message, { status: 400 });
    }
    const now = Date.now();
    let worker = workers.get(body.id);
    if (!worker) {
      worker = { id: body.id, url: '', slots, used: {}, kinds, token: null, capabilities: new Set(), version: null, lastSeen: now, draining: false, cooldownUntil: 0, jobs: new Set() };
      workers.set(body.id, worker);
      log(`worker ${body.id} joined at ${body.url} with slots ${JSON.stringify(slots)}`);
    }
    worker.url = body.url.replace(/\/+$/, '');
    worker.slots = slots;
    worker.kinds = kinds;
    worker.token = bearer;
    worker.capabilities = new Set(Array.isArray(body.capabilities) ? body.capabilities : []);
    worker.version = body.version ?? null;
    worker.lastSeen = now;

    // A job we sent that the worker no longer lists was lost (for example the worker restarted).
    if (Array.isArray(body.active)) {
      const active = new Set(body.active);
      for (const id of [...worker.jobs]) {
        const job = jobs.get(id);
        if (!job || job.final || active.has(id) || now - (job.assignedAt ?? now) < lostJobGraceMs) continue;
        job.push({ state: 'failed', error: { code: 'WORKER_LOST', message: `worker ${worker.id} no longer has the job` } });
        release(job, false);
      }
    }
    schedulePump();
    return { ok: true, heartbeatTimeoutMs };
  }

  function sweep() {
    const now = Date.now();
    for (const worker of [...workers.values()]) {
      if (now - worker.lastSeen > heartbeatTimeoutMs) {
        m.workersLost.inc();
        removeWorker(worker, { code: 'WORKER_LOST', message: `worker ${worker.id} missed its heartbeats` });
      }
    }
    pump();
  }

  const backend = {
    submit(input) {
      const spec = parseSpec(input);
      spec.id ??= `job_${randomUUID()}`;
      const existing = jobs.get(spec.id);
      if (existing) {
        if (canonicalJson(existing.spec) !== canonicalJson(spec)) {
          throw new FleetError('ID_CONFLICT', `job ${spec.id} already exists with a different spec`, { status: 409 });
        }
        return { created: false, job: existing.snapshot() };
      }
      if (queue.length >= maxQueued) throw new FleetError('QUEUE_FULL', 'queue is full', { status: 503 });
      pruneFinished(jobs, keepFinished);
      const job = /** @type {Job} */ (new JobRecord(spec));
      jobs.set(spec.id, job);
      jobStats.track(job);
      enqueue(job);
      pump();
      return { created: true, queued: queue.includes(job), job: job.snapshot() };
    },
    get: id => jobs.get(id)?.snapshot() ?? null,
    list: () => [...jobs.values()].map(j => j.snapshot()),
    subscribe(id, after, fn) {
      const job = jobs.get(id);
      if (!job) throw new FleetError('NOT_FOUND', `job ${id} not found`, { status: 404 });
      return job.subscribe(after, fn);
    },
    async cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (job.final) return job.snapshot();
      const idx = queue.indexOf(job);
      if (idx >= 0) {
        queue.splice(idx, 1);
        job.push({ state: 'cancelled', error: { code: 'CANCELLED', message: 'cancelled before it started' } });
        return job.snapshot();
      }
      const worker = job.worker;
      try {
        const res = await fetch(`${worker.url}/v1/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: workerHeaders(worker), signal: AbortSignal.timeout(5000) });
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
        if (res.status === 404) throw new Error('worker does not know the job');
      } catch (err) {
        // The worker cannot be told; record the cancel here so the slot is not held forever.
        job.push({ state: 'cancelled', error: { code: 'CANCELLED', message: `cancelled (worker ${worker.id} unreachable: ${err.message})` } });
        release(job);
      }
      return job.snapshot();
    },
    async writeStdin(id, data) {
      const job = jobs.get(id);
      if (!job) throw new FleetError('NOT_FOUND', `job ${id} not found`, { status: 404 });
      if (job.final || !job.worker || job.state === 'queued') throw new FleetError('NOT_RUNNING', 'job is not running', { status: 409 });
      const res = await fetch(`${job.worker.url}/v1/jobs/${encodeURIComponent(id)}/stdin`, {
        method: 'POST',
        headers: workerHeaders(job.worker, { 'content-type': 'application/octet-stream' }),
        body: data,
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new FleetError(body?.error?.code ?? 'STDIN_FAILED', body?.error?.message ?? `HTTP ${res.status}`, { status: res.status });
      return { bytes: body?.bytes ?? data.length };
    },
    /** Streams a running job's stdout from its worker; waits while the job is still queued. */
    async openStdout(id) {
      const job = jobs.get(id);
      if (!job) throw new FleetError('NOT_FOUND', `job ${id} not found`, { status: 404 });
      if (!job.spec.stdout) throw new FleetError('NO_STDOUT', 'job was not started with stdout: true', { status: 409 });
      const deadline = Date.now() + 60_000;
      while (!job.worker || job.state === 'queued') {
        if (job.final) throw new FleetError('NOT_RUNNING', 'job ended before it started', { status: 409 });
        if (Date.now() > deadline) throw new FleetError('NOT_RUNNING', 'job did not start in time', { status: 409 });
        await new Promise(r => setTimeout(r, 100));
      }
      return getStream(`${job.worker.url}/v1/jobs/${encodeURIComponent(id)}/stdout`, { headers: workerHeaders(job.worker) });
    },
    capabilities() {
      const pools = {};
      const caps = new Set();
      for (const w of workers.values()) {
        for (const [pool, total] of Object.entries(w.slots)) {
          pools[pool] ??= { total: 0, used: 0 };
          pools[pool].total += total;
          pools[pool].used += w.used[pool] ?? 0;
        }
        for (const c of w.capabilities) caps.add(c);
      }
      return { role: 'orchestrator', version: VERSION, workers: workers.size, slots: pools, queued: queue.length, capabilities: [...caps].sort() };
    },
  };

  async function extraRoutes(req, res, reqUrl, who) {
    const path = reqUrl.pathname;
    if (path === '/v1/auth/token' && req.method === 'POST') {
      const raw = (await readBody(req, 64 * 1024)).toString('utf8');
      const json = (req.headers['content-type'] ?? '').includes('application/json');
      let body;
      try {
        body = json ? JSON.parse(raw || '{}') : new URLSearchParams(raw);
      } catch {
        body = {};
      }
      const out = await issueToken({ req, body, clients: clientStore, signer });
      if (out.status === 200) m.tokensIssued.inc({ client: out.body.access_token && JSON.parse(Buffer.from(out.body.access_token.split('.')[1], 'base64url')).sub });
      else m.loginFailures.inc({ error: out.body.error });
      send(res, out.status, out.body, out.headers);
      return true;
    }
    if (path === '/v1/auth/keys' && req.method === 'GET') {
      // Public keys are public: workers fetch them to check tokens without holding a secret.
      send(res, 200, signer.jwks(), { 'cache-control': 'max-age=300' });
      return true;
    }
    if (path === '/v1/workers/register' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const given = bearerOf(req);
        // The shared worker token, or the join secret of a worker this orchestrator started itself.
        const ok = checkBearer(req, workerToken) || (given && body && autoscaler?.acceptsJoin(body.id, given));
        if (!ok) {
          send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'missing or wrong worker token' } });
          return true;
        }
        send(res, 200, register(body, given));
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }
    if (path === '/v1/sd/prometheus' && req.method === 'GET') {
      // Prometheus HTTP service discovery: one target per worker, scraped at its /metrics.
      if (allowed(res, who, 'metrics')) {
        send(res, 200, [...workers.values()].map(w => {
          const u = new URL(w.url);
          return { targets: [u.host], labels: { __scheme__: u.protocol.slice(0, -1), __metrics_path__: `${u.pathname.replace(/\/+$/, '')}/metrics`, fffleet_worker: w.id } };
        }));
      }
      return true;
    }
    if (path === '/v1/pools' && req.method === 'GET') {
      if (allowed(res, who, 'admin')) send(res, 200, autoscaler ? autoscaler.describe() : { pools: [] });
      return true;
    }
    const drain = path.match(/^\/v1\/workers\/([^/]+)\/drain$/);
    if ((path === '/v1/workers' && req.method === 'GET') || (drain && req.method === 'POST')) {
      if (!allowed(res, who, 'admin')) return true;
      if (drain) {
        const worker = workers.get(decodeURIComponent(drain[1]));
        if (!worker) send(res, 404, { error: { code: 'NOT_FOUND', message: 'worker not found' } });
        else {
          worker.draining = true;
          send(res, 200, describe(worker));
        }
        return true;
      }
      send(res, 200, { workers: [...workers.values()].map(describe) });
      return true;
    }
    return false;
  }

  function describe(w) {
    return { id: w.id, url: w.url, slots: w.slots, kinds: w.kinds, used: w.used, draining: w.draining, version: w.version, lastSeen: new Date(w.lastSeen).toISOString(), jobs: [...w.jobs], capabilityCount: w.capabilities.size };
  }

  return {
    backend,
    workers,
    registry,
    signer,
    get autoscaler() {
      return autoscaler;
    },
    get url() {
      return url;
    },
    async start() {
      ({ server, url } = await listen(createApiHandler({ backend, authenticate, metrics: () => registry.render(), extraRoutes }), { port, host }));
      if (!token && !clientStore) log('no FFFLEET_TOKEN and no clients file: the job API is open to anyone who can reach it');
      sweeper = setInterval(sweep, sweepMs);
      sweeper.unref?.();
      log(`fffleet-orchestrator listening on ${url}`);
      if (scaling) {
        const view = {
          queue: () => queue.map(j => ({ id: j.id, spec: j.spec, waitedMs: Date.now() - Date.parse(j.createdAt) })),
          workers: () => workers.values(),
          drain: id => {
            const w = workers.get(id);
            if (w) w.draining = true;
          },
          forget: id => {
            const w = workers.get(id);
            if (w) removeWorker(w, { code: 'WORKER_REMOVED', message: `worker ${id} was removed by the autoscaler` });
          },
          publicUrl: () => scaling.publicUrl ?? url,
        };
        const providers = createProviders(scaling, { onExit: id => autoscaler?.exited(id), log, overrides: providerOverrides });
        autoscaler = createAutoscaler({
          config: scaling,
          providers,
          view,
          joinKey: joinKey ?? scaling.autoscale.joinSecret ?? signingKeyBytes() ?? undefined,
          log: msg => log(msg),
          metrics: scaleMetrics,
        });
        await autoscaler.start();
      }
      return this;
    },
    async stop() {
      await autoscaler?.stop();
      clearInterval(sweeper);
      clearTimeout(pumpTimer);
      for (const job of jobs.values()) job.follow?.abort();
      if (server) await close(server);
    },
  };
}
