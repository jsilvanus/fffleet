import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { createAutoscaler } from '../src/autoscaler.js';

/** A hand-driven world: a clock, a queue, workers, and providers that record what they are asked. */
function world(poolDocs, { autoscale = {}, billing = {} } = {}) {
  const config = normalizeConfig({ publicUrl: 'http://orch:5000', autoscale: { scaleUpAfter: '10s', idleAfter: '5m', bootTimeout: '2m', ...autoscale }, pools: poolDocs });
  let clock = 1_000_000;
  const queue = [];
  const workers = new Map();
  const created = [];
  const destroyed = [];
  const drained = [];
  const providers = Object.fromEntries(config.pools.map(p => [p.name, {
    billing: billing[p.name] ?? null,
    failNext: 0,
    existing: [],
    async list() {
      return this.existing;
    },
    async create(req) {
      if (this.failNext > 0) {
        this.failNext--;
        throw new Error('no capacity');
      }
      created.push({ ...req, pool: p.name });
      return { providerId: `srv-${created.length}` };
    },
    async destroy(id) {
      destroyed.push(id);
    },
  }]));
  const view = {
    queue: () => queue.map(j => ({ ...j, waitedMs: clock - j.queuedAt })),
    workers: () => workers.values(),
    drain: id => drained.push(id),
    forget: id => workers.delete(id),
    publicUrl: () => 'http://orch:5000',
  };
  const log = [];
  const scaler = createAutoscaler({ config, providers, view, joinKey: 'k', log: m => log.push(m), now: () => clock });
  const world = {
    scaler, created, destroyed, drained, queue, workers, providers, log,
    advance: ms => { clock += ms; },
    job: (spec = {}) => {
      const j = { id: `j${queue.length}`, queuedAt: clock, spec: { kind: 'batch', type: 'ffmpeg', class: 'default', requires: [], inputs: [], outputs: [], ...spec } };
      queue.push(j);
      return j;
    },
    /** The worker of the n-th created instance registers. */
    register: (n = created.length - 1, extra = {}) => {
      const id = created[n].workerId;
      workers.set(id, { id, jobs: new Set(), capabilities: new Set(extra.capabilities ?? ['type:ffmpeg']), ...extra });
      return id;
    },
  };
  return world;
}

const pool = (name, extra = {}) => ({ name, provider: 'process', min: 0, max: 3, slots: 'default=2', ...extra });

test('a queued job that has waited gets a worker; one that has not, does not', async () => {
  const w = world([pool('local')]);
  await w.scaler.tick();
  assert.equal(w.created.length, 0, 'nothing queued, nothing started');
  w.job();
  await w.scaler.tick();
  assert.equal(w.created.length, 0, 'the job has not waited long enough');
  w.advance(10_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 1);
  const c = w.created[0];
  assert.match(c.workerId, /^local-[0-9a-f]{6}$/);
  assert.equal(c.env.FFFLEET_ORCHESTRATOR_URL, 'http://orch:5000');
  assert.equal(c.env.FFFLEET_SLOTS, 'default=2');
  assert.equal(c.env.FFFLEET_KINDS, 'stream,batch');
  assert.equal(c.env.FFFLEET_TOKEN, c.env.FFFLEET_WORKER_TOKEN);
  assert.notEqual(c.env.FFFLEET_TOKEN, 'k', 'the join secret is derived, never the key');
  assert.deepEqual(c.labels, { 'fffleet.orchestrator': 'default', 'fffleet.pool': 'local', 'fffleet.worker': c.workerId });
});

test('a worker on the way covers its slots, so more jobs do not start more workers', async () => {
  const w = world([pool('local', { slots: 'default=2' })]);
  w.job();
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  await w.scaler.tick();
  assert.equal(w.created.length, 1, 'two jobs fit the two slots of one worker');
  w.job();
  await w.scaler.tick();
  assert.equal(w.created.length, 1, 'the third job has not waited yet');
  w.advance(11_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 2, 'now it has, and the first worker is full');
});

test('pools fill in order, and max stops a pool', async () => {
  const w = world([pool('local', { max: 1, slots: 'default=1' }), pool('cloud', { max: 2, slots: 'default=1' })]);
  for (let i = 0; i < 5; i++) w.job();
  w.advance(11_000);
  await w.scaler.tick();
  assert.deepEqual(w.created.map(c => c.pool).sort(), ['cloud', 'cloud', 'local'], 'local first, then cloud, then nothing: max total 3');
  assert.equal(w.scaler.describe().pools.find(p => p.name === 'cloud').instances, 2);
});

test('autoscale.maxWorkers caps all pools together', async () => {
  const w = world([pool('a', { max: 5, slots: 'default=1' }), pool('b', { max: 5, slots: 'default=1' })], { autoscale: { maxWorkers: 3 } });
  for (let i = 0; i < 10; i++) w.job();
  w.advance(11_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 2, 'at most maxConcurrentCreates per tick');
  await w.scaler.tick();
  assert.equal(w.created.length, 3, 'then the total cap');
  await w.scaler.tick();
  assert.equal(w.created.length, 3);
});

test('batch and stream jobs go to pools of the right kind', async () => {
  const w = world([pool('batchers', { kinds: ['batch'] }), pool('streamers', { kinds: ['stream'] })]);
  w.job({ kind: 'stream' });
  w.advance(11_000);
  await w.scaler.tick();
  assert.deepEqual(w.created.map(c => c.pool), ['streamers']);
  assert.equal(w.created[0].env.FFFLEET_KINDS, 'stream');
  w.job({ kind: 'batch' });
  w.advance(11_000);
  await w.scaler.tick();
  assert.deepEqual(w.created.map(c => c.pool), ['streamers', 'batchers']);
});

test('a job needing a capability only starts workers of a pool that has it', async () => {
  const w = world([
    pool('plain'),
    pool('storage', { capabilities: ['scheme:s3', 'font:*'] }),
  ]);
  w.job({ requires: ['font:DejaVu Sans'] });
  w.job({ inputs: [{ name: 'i', uri: 's3://b/k' }] });
  w.advance(11_000);
  await w.scaler.tick();
  assert.deepEqual(w.created.map(c => c.pool), ['storage']);
  assert.equal(w.created[0].env.FFFLEET_CAPABILITIES, 'scheme:s3');
  w.job({ requires: ['filter:nonexistent'] });
  w.advance(11_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 1, 'no pool offers it, so nothing starts');
});

test('S3 credentials in a pool imply the s3 capability; observed capabilities are remembered', async () => {
  const w = world([pool('s3pool', { env: { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' } }), pool('other')]);
  w.job({ outputs: [{ name: 'o', uri: 's3://b/o.mp4' }] });
  w.advance(11_000);
  await w.scaler.tick();
  assert.deepEqual(w.created.map(c => c.pool), ['s3pool']);

  w.job({ requires: ['encoder:libx264'] });
  w.advance(11_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 1, 'unknown before any worker has reported');
  w.register(0, { capabilities: ['type:ffmpeg', 'encoder:libx264'] });
  await w.scaler.tick();
  w.workers.get(w.created[0].workerId).jobs.add('busy');
  w.advance(11_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 2, 'now the pool is known to have it');
});

test('min keeps a pool populated without any demand', async () => {
  const w = world([pool('base', { min: 2, max: 3 })]);
  await w.scaler.tick();
  assert.equal(w.created.length, 2);
  await w.scaler.tick();
  assert.equal(w.created.length, 2, 'booting workers count');
});

test('an idle worker is drained and removed after idleAfter, down to min', async () => {
  const w = world([pool('p', { min: 1, max: 3, slots: 'default=1' })]);
  await w.scaler.tick();
  w.job();
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 2);
  w.register(0);
  w.register(1);
  w.queue.length = 0;
  await w.scaler.tick();
  w.advance(4 * 60_000);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 0, 'not idle long enough');
  w.advance(2 * 60_000);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 1, 'one is removed; min keeps the other');
  assert.equal(w.drained.length, 1);
  assert.equal(w.scaler.describe().pools[0].instances, 1);
});

test('a busy worker is never removed, and work in the queue keeps idle ones', async () => {
  const w = world([pool('p', { min: 0, max: 2, slots: 'default=1' })], { autoscale: { idleAfter: '1m' } });
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  const id = w.register(0);
  w.workers.get(id).jobs.add('stream-1');
  w.queue.length = 0;
  w.advance(10 * 60_000);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 0, 'a running job holds its worker');
  w.workers.get(id).jobs.clear();
  w.job();
  w.advance(5_000);
  await w.scaler.tick();
  w.advance(10 * 60_000);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 0, 'a queued job it could run keeps it');
});

test('billing alignment: an idle paid server is kept until near the end of its billed hour', async () => {
  const HOUR = 3_600_000;
  const w = world([pool('cloud', { min: 0, max: 1 })], { billing: { cloud: { alignMs: HOUR, windowMs: 5 * 60_000 } } });
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  w.register(0);
  await w.scaler.tick();
  w.queue.length = 0;
  w.advance(10 * 60_000);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 0, 'idle for ten minutes, but only ten minutes into a paid hour');
  w.advance(45 * 60_000);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 1, 'inside the last five minutes of the hour');
});

test('a worker that never registers is removed after bootTimeout and the pool backs off', async () => {
  const w = world([pool('p', { max: 2 })]);
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 1);
  w.advance(121_000);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 1);
  assert.match(w.log.join('\n'), /did not register within 120s/);
  await w.scaler.tick();
  assert.equal(w.created.length, 1, 'backing off after a failure');
  w.advance(11 * 60_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 2, 'tries again after the backoff');
});

test('a failed create backs the pool off and is retried; creating more than maxConcurrentCreates is spread out', async () => {
  const w = world([pool('p', { max: 5, slots: 'default=1', maxConcurrentCreates: 2 })]);
  w.providers.p.failNext = 1;
  for (let i = 0; i < 4; i++) w.job();
  w.advance(11_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 1, 'one of two attempts failed');
  assert.match(w.log.join('\n'), /could not start a worker in pool p: no capacity/);
  w.advance(60_000);
  await w.scaler.tick();
  assert.equal(w.created.length, 3, 'two more after the backoff, not three');
});

test('a ready worker that disappears from the registry has its instance removed', async () => {
  const w = world([pool('p')]);
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  const id = w.register(0);
  await w.scaler.tick();
  w.workers.delete(id);
  await w.scaler.tick();
  assert.deepEqual(w.destroyed, ['srv-1']);
});

test('join secrets: derived per worker, accepted only for live instances', async () => {
  const w = world([pool('p')]);
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  const { workerId, env } = w.created[0];
  assert.equal(w.scaler.acceptsJoin(workerId, env.FFFLEET_TOKEN), true);
  assert.equal(w.scaler.acceptsJoin(workerId, 'wrong'), false);
  assert.equal(w.scaler.acceptsJoin('p-unknown', env.FFFLEET_TOKEN), false);
  assert.equal(w.scaler.acceptsJoin(workerId, undefined), false);
  assert.notEqual(w.scaler.joinSecret('a'), w.scaler.joinSecret('b'));
  w.advance(121_000);
  await w.scaler.tick();
  assert.equal(w.scaler.acceptsJoin(workerId, env.FFFLEET_TOKEN), false, 'a removed instance cannot rejoin');
});

test('after a restart it adopts instances found at the provider and removes ones that never register', async () => {
  const w = world([pool('p', { min: 0 })]);
  w.providers.p.existing = [
    { providerId: 'old-1', workerId: 'p-aaaaaa', pool: 'p', createdAt: 1_000_000 - 30_000 },
    { providerId: 'old-2', workerId: 'p-bbbbbb', pool: 'p', createdAt: 1_000_000 - 30_000 },
  ];
  await w.scaler.start();
  assert.equal(w.scaler.acceptsJoin('p-aaaaaa', w.scaler.joinSecret('p-aaaaaa')), true, 'its join secret is recognised again');
  w.workers.set('p-aaaaaa', { id: 'p-aaaaaa', jobs: new Set(), capabilities: new Set() });
  w.advance(121_000);
  await w.scaler.tick();
  assert.deepEqual(w.destroyed, ['old-2'], 'the one that registered stays, the silent one is removed');
  await w.scaler.stop();
});

test('a destroy that fails is retried on the next tick', async () => {
  const w = world([pool('p')]);
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  let fails = 2;
  w.providers.p.destroy = async id => {
    if (fails-- > 0) throw new Error('api down');
    w.destroyed.push(id);
  };
  w.advance(121_000);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 0);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 0);
  await w.scaler.tick();
  assert.deepEqual(w.destroyed, ['srv-1']);
});

test('exited() marks a process worker for removal', async () => {
  const w = world([pool('p')]);
  w.job();
  w.advance(11_000);
  await w.scaler.tick();
  w.scaler.exited(w.created[0].workerId);
  await w.scaler.tick();
  assert.equal(w.destroyed.length, 1);
});
