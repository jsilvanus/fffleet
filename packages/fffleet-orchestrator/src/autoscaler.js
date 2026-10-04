import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { implicitRequirements } from 'fffleet';

/**
 * Starts and stops workers to match demand.
 *
 * Pools are tried in the order they are configured, so a pool on this host listed before a cloud
 * pool is filled first. A pool grows when a queued job has waited `scaleUpAfter` and no worker that
 * could take it is on the way, and shrinks when a worker has been idle for `idleAfter`.
 *
 * Every instance it starts is labelled with this orchestrator's id, so after a restart it adopts the
 * ones that register again and deletes the rest instead of leaking paid servers. Instances never see
 * the shared worker token: each gets a join secret derived from the worker id with a key only the
 * orchestrator holds, so a restart can recognise it again without storing anything.
 *
 * @param {object} opts
 * @param {{ autoscale: any, pools: any[], publicUrl: string | null }} opts.config   See normalizeConfig.
 * @param {Record<string, any>} opts.providers   pool name -> provider (create, destroy, list, close, billing).
 * @param {{ queue(): any[], workers(): Iterable<any>, drain(id: string): void, forget(id: string): void, publicUrl(): string }} opts.view
 * @param {Buffer | string} [opts.joinKey]
 * @param {(msg: string) => void} [opts.log]
 * @param {object} [opts.metrics]   counters and gauges from the orchestrator's registry.
 * @param {() => number} [opts.now]
 */
export function createAutoscaler({ config, providers, view, joinKey = randomBytes(32), log = () => {}, metrics = null, now = Date.now }) {
  const { autoscale } = config;
  const pools = new Map(config.pools.map(p => [p.name, { ...p, observed: new Set(), failures: 0, backoffUntil: 0 }]));
  /** @type {Map<string, { id: string, pool: string, providerId: string | null, state: 'creating' | 'booting' | 'ready' | 'draining' | 'removing', createdAt: number, idleSince: number | null, adopted?: boolean, destroyAttempts?: number }>} */
  const instances = new Map();
  let timer = null;
  let ticking = false;
  let stopped = false;

  const joinSecret = workerId => createHmac('sha256', joinKey).update(`fffleet-worker:${workerId}`).digest('base64url');
  const labels = (pool, workerId) => ({ 'fffleet.orchestrator': autoscale.id, 'fffleet.pool': pool.name, 'fffleet.worker': workerId });

  const alive = pool => [...instances.values()].filter(i => i.pool === pool.name && i.state !== 'removing');
  const count = (pool, ...states) => [...instances.values()].filter(i => i.pool === pool.name && states.includes(i.state)).length;
  const totalAlive = () => [...instances.values()].filter(i => i.state !== 'removing').length;

  /** What a worker of this pool can do: what the config declares plus what its running workers reported. */
  function poolCaps(pool) {
    return [...pool.capabilities, ...pool.observed];
  }

  function hasCap(caps, required) {
    return caps.some(c => c === required || (c.endsWith('*') && required.startsWith(c.slice(0, -1))));
  }

  /** Whether a worker started from this pool could run the job. */
  function canServe(pool, spec) {
    if (!pool.kinds.includes(spec.kind)) return false;
    const needs = [...implicitRequirements(spec), ...spec.requires].filter(r => !(r === 'type:ffmpeg' && spec.type === 'ffmpeg'));
    const caps = poolCaps(pool);
    return needs.every(r => hasCap(caps, r));
  }

  /** How many queued jobs one new worker of this pool is expected to absorb. */
  function slotsPerWorker(pool) {
    if (pool.slotsHint) return pool.slotsHint;
    if (!pool.slotsAuto) return Math.max(1, pool.slotsResolved.default ?? Object.values(pool.slotsResolved)[0] ?? 1);
    return 2;
  }

  async function create(pool) {
    const workerId = `${pool.name}-${randomUUID().slice(0, 6)}`;
    const inst = { id: workerId, pool: pool.name, provider: providers[pool.name], providerId: null, state: 'creating', createdAt: now(), idleSince: null };
    instances.set(workerId, inst);
    const secret = joinSecret(workerId);
    const env = {
      FFFLEET_WORKER_ID: workerId,
      FFFLEET_ORCHESTRATOR_URL: view.publicUrl(),
      FFFLEET_TOKEN: secret,
      FFFLEET_WORKER_TOKEN: secret,
      FFFLEET_SLOTS: pool.slots,
      FFFLEET_KINDS: pool.kinds.join(','),
      ...(pool.capabilities.some(c => !c.endsWith('*')) ? { FFFLEET_CAPABILITIES: pool.capabilities.filter(c => !c.endsWith('*')).join(',') } : {}),
      ...pool.env,
    };
    try {
      const made = await inst.provider.create({ workerId, pool, env, labels: labels(pool, workerId) });
      inst.providerId = made.providerId;
      inst.state = 'booting';
      inst.createdAt = now();
      metrics?.creates.inc({ pool: pool.name, result: 'ok' });
      log(`autoscaler: started worker ${workerId} in pool ${pool.name}`);
    } catch (err) {
      instances.delete(workerId);
      pool.failures++;
      pool.backoffUntil = now() + Math.min(10 * 60000, 5000 * 2 ** Math.min(pool.failures, 7));
      metrics?.creates.inc({ pool: pool.name, result: 'error' });
      log(`autoscaler: could not start a worker in pool ${pool.name}: ${err.message}; retrying after ${Math.round((pool.backoffUntil - now()) / 1000)}s`);
    }
  }

  async function destroy(inst, reason) {
    if (inst.state !== 'removing') {
      inst.state = 'removing';
      inst.destroyReason = reason;
    }
    view.forget(inst.id);
    try {
      if (inst.providerId !== null) await inst.provider.destroy(inst.providerId);
      instances.delete(inst.id);
      metrics?.destroys.inc({ pool: inst.pool, reason });
      log(`autoscaler: removed worker ${inst.id} (${reason})`);
    } catch (err) {
      inst.destroyAttempts = (inst.destroyAttempts ?? 0) + 1;
      log(`autoscaler: could not remove worker ${inst.id} (attempt ${inst.destroyAttempts}): ${err.message}; will retry`);
    }
  }

  /** Marks instances ready when their worker registers, and removes ones whose worker vanished. */
  function sync() {
    const known = new Map([...view.workers()].map(w => [w.id, w]));
    for (const inst of [...instances.values()]) {
      const w = known.get(inst.id);
      const pool = pools.get(inst.pool);
      if (inst.state === 'booting' && w) {
        inst.state = 'ready';
        inst.idleSince = now();
        if (pool) {
          pool.failures = 0;
          for (const c of w.capabilities) pool.observed.add(c);
        }
        log(`autoscaler: worker ${inst.id} is up after ${Math.round((now() - inst.createdAt) / 1000)}s`);
      } else if (inst.state === 'ready' && !w) {
        inst.state = 'removing';
        inst.destroyReason = 'lost';
      } else if (inst.state === 'booting' && !w && now() - inst.createdAt > autoscale.bootTimeout) {
        inst.state = 'removing';
        inst.destroyReason = 'boot-timeout';
        if (pool) {
          pool.failures++;
          pool.backoffUntil = now() + Math.min(10 * 60000, 5000 * 2 ** Math.min(pool.failures, 7));
        }
        log(`autoscaler: worker ${inst.id} did not register within ${Math.round(autoscale.bootTimeout / 1000)}s`);
      } else if (!pool && inst.state !== 'removing') {
        inst.state = 'removing';
        inst.destroyReason = 'pool-removed';
      }
    }
  }

  async function scaleUp() {
    const t = now();
    const planned = new Map([...pools.keys()].map(n => [n, 0]));
    const assigned = new Map([...pools.keys()].map(n => [n, 0]));
    const room = pool => alive(pool).length + planned.get(pool.name) < pool.max
      && totalAlive() + [...planned.values()].reduce((a, b) => a + b, 0) < autoscale.maxWorkers;

    // Queued jobs that have waited go to the first pool that could run them. A worker that is
    // already on the way covers its share of them; only the rest need new workers.
    for (const job of view.queue()) {
      if (job.waitedMs < autoscale.scaleUpAfter) continue;
      for (const pool of pools.values()) {
        if (!canServe(pool, job.spec) || t < pool.backoffUntil) continue;
        const coverage = (count(pool, 'creating', 'booting') + planned.get(pool.name)) * slotsPerWorker(pool);
        if (assigned.get(pool.name) < coverage) {
          assigned.set(pool.name, assigned.get(pool.name) + 1);
          break;
        }
        if (room(pool)) {
          planned.set(pool.name, planned.get(pool.name) + 1);
          assigned.set(pool.name, assigned.get(pool.name) + 1);
          break;
        }
      }
    }

    const creating = [];
    for (const pool of pools.values()) {
      if (t < pool.backoffUntil) continue;
      const missingMin = pool.min - alive(pool).length;
      const toStart = Math.min(Math.max(planned.get(pool.name), missingMin), pool.maxConcurrentCreates);
      for (let i = 0; i < toStart; i++) creating.push(create(pool));
    }
    await Promise.all(creating);
  }

  function billingAligned(inst, provider) {
    const b = provider?.billing;
    if (!b) return true;
    const age = now() - inst.createdAt;
    return age % b.alignMs >= b.alignMs - b.windowMs;
  }

  async function scaleDown() {
    const known = new Map([...view.workers()].map(w => [w.id, w]));
    const queue = view.queue();
    const t = now();
    for (const inst of [...instances.values()]) {
      const pool = pools.get(inst.pool);
      const w = known.get(inst.id);
      if (!pool || !w) continue;
      const idle = w.jobs.size === 0;
      if (inst.state === 'draining') {
        if (idle) await destroy(inst, 'idle');
        continue;
      }
      if (inst.state !== 'ready') continue;
      if (!idle || queue.some(j => canServe(pool, j.spec))) {
        inst.idleSince = null;
        continue;
      }
      inst.idleSince ??= t;
      const idleAfter = pool.idleAfter ?? autoscale.idleAfter;
      if (t - inst.idleSince < idleAfter || alive(pool).length <= pool.min) continue;
      if (!billingAligned(inst, inst.provider)) continue;
      inst.state = 'draining';
      view.drain(inst.id);
      log(`autoscaler: draining idle worker ${inst.id}`);
      if (idle) await destroy(inst, 'idle');
    }
  }

  async function retryRemovals() {
    for (const inst of [...instances.values()]) if (inst.state === 'removing') await destroy(inst, inst.destroyReason ?? 'removed');
  }

  function report() {
    if (!metrics) return;
    metrics.instances.reset();
    for (const pool of pools.values()) {
      for (const state of ['creating', 'booting', 'ready', 'draining', 'removing']) metrics.instances.set({ pool: pool.name, state }, count(pool, state));
    }
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      sync();
      await retryRemovals();
      await scaleUp();
      await scaleDown();
      report();
    } catch (err) {
      log(`autoscaler: tick failed: ${err.stack ?? err.message}`);
    } finally {
      ticking = false;
    }
  }

  return {
    /** Adopts instances that survived an orchestrator restart, then starts ticking. */
    async start() {
      for (const [name, provider] of Object.entries(providers)) {
        let found = [];
        try {
          found = await provider.list(autoscale.id);
        } catch (err) {
          log(`autoscaler: could not list existing instances of pool ${name}: ${err.message}`);
        }
        for (const f of found) {
          if (instances.has(f.workerId)) continue;
          // A pool's workers belong to that pool even if the listing came from a shared provider.
          instances.set(f.workerId, { id: f.workerId, pool: f.pool, provider, providerId: f.providerId, state: 'booting', createdAt: f.createdAt ?? now(), idleSince: null, adopted: true });
          log(`autoscaler: found worker ${f.workerId} from before the restart in pool ${f.pool}`);
        }
      }
      stopped = false;
      await tick();
      timer = setInterval(tick, autoscale.interval);
      timer.unref?.();
    },

    tick,

    /** Stops ticking. Workers are left running: they re-register with the next orchestrator. */
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const provider of new Set(Object.values(providers))) await provider.close?.();
    },

    /** Whether `secret` is the join secret of an instance this orchestrator started. */
    acceptsJoin(workerId, secret) {
      const inst = typeof workerId === 'string' ? instances.get(workerId) : null;
      if (!inst || inst.state === 'removing' || typeof secret !== 'string') return false;
      const want = Buffer.from(joinSecret(workerId));
      const got = Buffer.from(secret);
      return got.length === want.length && timingSafeEqual(got, want);
    },

    /** A process provider tells us its worker exited. */
    exited(workerId) {
      const inst = instances.get(workerId);
      if (inst && inst.state !== 'removing') {
        inst.state = 'removing';
        inst.destroyReason = 'exited';
      }
    },

    describe() {
      return {
        pools: [...pools.values()].map(p => ({
          name: p.name,
          provider: p.provider,
          kinds: p.kinds,
          slots: p.slots,
          min: p.min,
          max: p.max,
          instances: alive(p).length,
          backoffSeconds: Math.max(0, Math.ceil((p.backoffUntil - now()) / 1000)),
          workers: [...instances.values()].filter(i => i.pool === p.name).map(i => ({ id: i.id, state: i.state, ageSeconds: Math.round((now() - i.createdAt) / 1000), providerId: i.providerId })),
        })),
      };
    },

    joinSecret,
    canServe,
  };
}
