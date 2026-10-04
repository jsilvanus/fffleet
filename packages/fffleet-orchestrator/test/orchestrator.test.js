import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleet } from 'fffleet';
import { close, listen } from 'fffleet/server';
import { createWorker } from 'fffleet-worker';
import { createOrchestrator } from '../src/orchestrator.js';

const TOKEN = 'client';
const WORKER_TOKEN = 'worker';
let tmp;
const cleanups = [];

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fffleet-orch-'));
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});
after(() => rm(tmp, { recursive: true, force: true }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
};

/** Test executor: each job runs until the test releases, fails or cancels it. */
function fakeExecutor() {
  const controls = new Map();
  const executor = (spec, rt) =>
    new Promise((resolve, reject) => {
      if (rt.signal.aborted) return reject(rt.signal.reason);
      rt.setState('running');
      rt.signal.addEventListener('abort', () => reject(rt.signal.reason), { once: true });
      controls.set(spec.id, { release: () => resolve({ exitCode: 0, outputs: [] }), rt });
    });
  return { executor, controls };
}

async function orchestrator(opts = {}) {
  const o = createOrchestrator({ port: 0, host: '127.0.0.1', token: TOKEN, workerToken: WORKER_TOKEN, sweepMs: 50, ...opts });
  await o.start();
  cleanups.push(() => o.stop());
  return o;
}

async function worker(o, id, opts = {}) {
  const fake = fakeExecutor();
  const w = createWorker({
    id, port: 0, host: '127.0.0.1', token: WORKER_TOKEN, workRoot: join(tmp, id), slots: { default: 1 },
    orchestratorUrl: o.url, orchestratorToken: WORKER_TOKEN, heartbeatMs: 50, progressIntervalMs: 0,
    executors: { fake: fake.executor }, ...opts,
  });
  await w.start();
  cleanups.push(() => w.stop());
  await until(() => o.workers.has(id));
  return { w, ...fake };
}

function client(o) {
  const fleet = createFleet({ url: o.url, token: TOKEN, fallback: 'none' });
  cleanups.push(() => fleet.close());
  return fleet;
}

const fakeJob = (id, extra = {}) => ({ id, kind: 'batch', type: 'fake', ...extra });

async function call(o, path, { method = 'GET', body, token = TOKEN } = {}) {
  const res = await fetch(o.url + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('dispatches to the least loaded worker and relays events to the client', async () => {
  const o = await orchestrator();
  const a = await worker(o, 'a', { slots: { default: 2 } });
  const b = await worker(o, 'b', { slots: { default: 2 } });
  const fleet = client(o);
  const jobs = await Promise.all(['j1', 'j2'].map(id => fleet.submit(fakeJob(id))));
  await until(() => jobs.every(j => j.state === 'running'));
  const placed = ['j1', 'j2'].map(id => o.backend.get(id).workerId).sort();
  assert.deepEqual(placed, ['a', 'b'], 'spread across workers');

  const states = [];
  jobs[0].on('state', s => states.push(s));
  const ctl = a.controls.get('j1') ?? b.controls.get('j1');
  ctl.rt.progress({ pct: 30 });
  ctl.release();
  const snap = await jobs[0].done;
  assert.equal(snap.state, 'succeeded');
  assert.ok(['a', 'b'].includes(snap.workerId));
  assert.equal(snap.progress.pct, 100);
  assert.deepEqual(states, ['succeeded']);
  await jobs[1].cancel();
  assert.equal((await jobs[1].done).state, 'cancelled');
});

test('auth: clients and workers use different tokens', async () => {
  const o = await orchestrator();
  assert.equal((await call(o, '/v1/health', { token: null })).status, 200);
  assert.equal((await call(o, '/v1/jobs', { token: WORKER_TOKEN })).status, 401);
  assert.equal((await call(o, '/v1/workers', { token: WORKER_TOKEN })).status, 401);
  assert.equal((await call(o, '/v1/workers/register', { method: 'POST', token: TOKEN, body: { id: 'x', url: 'http://x' } })).status, 401);
  assert.equal((await call(o, '/v1/workers/register', { method: 'POST', token: WORKER_TOKEN, body: { id: 'x' } })).status, 400);
  assert.equal((await call(o, '/v1/workers/register', { method: 'POST', token: WORKER_TOKEN, body: { id: 'x', url: 'http://x', slots: 'bad=-1' } })).status, 400);
});

test('submit: 202 when no worker fits, 200 on repeat, 409 on conflict, 503 when the queue is full', async () => {
  const o = await orchestrator({ maxQueued: 1 });
  const first = await call(o, '/v1/jobs', { method: 'POST', body: fakeJob('q1') });
  assert.equal(first.status, 202);
  assert.equal(first.body.state, 'queued');
  assert.equal((await call(o, '/v1/jobs', { method: 'POST', body: fakeJob('q1') })).status, 200);
  assert.equal((await call(o, '/v1/jobs', { method: 'POST', body: fakeJob('q1', { priority: 1 }) })).status, 409);
  const full = await call(o, '/v1/jobs', { method: 'POST', body: fakeJob('q2') });
  assert.equal(full.status, 503);
  assert.equal(full.body.error.code, 'QUEUE_FULL');
  const caps = await call(o, '/v1/capabilities');
  assert.equal(caps.body.role, 'orchestrator');
  assert.equal(caps.body.queued, 1);
  // A worker joining picks up the queued job.
  const w = await worker(o, 'late');
  await until(() => w.controls.has('q1'));
  assert.equal((await call(o, '/v1/jobs', { method: 'POST', body: fakeJob('q2') })).status, 202, 'slot busy -> queued');
});

test('a job goes only to a worker with its type, required capabilities and class pool', async () => {
  const o = await orchestrator();
  const plain = await worker(o, 'plain', { slots: { default: 1 } });
  const special = await worker(o, 'special', { slots: { default: 1, gpu: 1 }, extraCapabilities: ['hw:gpu'] });
  const fleet = client(o);
  const gpu = await fleet.submit(fakeJob('gpu', { class: 'gpu', requires: ['hw:gpu'] }));
  await until(() => gpu.state === 'running');
  assert.equal(o.backend.get('gpu').workerId, 'special');
  assert.equal(plain.controls.size, 0);
  const ff = await fleet.submit({ id: 'ff', kind: 'batch', requires: ['hw:none'], ffmpeg: { args: ['-version'] } });
  await sleep(150);
  assert.equal(ff.state, 'queued', 'nobody has hw:none');
  await ff.cancel();
  special.controls.get('gpu').release();
  await gpu.done;
});

test('priority decides which queued job a freed slot takes', async () => {
  const o = await orchestrator();
  const w = await worker(o, 'solo');
  const fleet = client(o);
  await fleet.submit(fakeJob('first'));
  await until(() => w.controls.has('first'));
  await fleet.submit(fakeJob('low', { priority: -1 }));
  await fleet.submit(fakeJob('normal'));
  await fleet.submit(fakeJob('urgent', { priority: 100 }));
  const order = [];
  for (const id of ['first', 'urgent', 'normal', 'low']) {
    await until(() => w.controls.has(id));
    order.push(id);
    w.controls.get(id).release();
  }
  assert.deepEqual(order, ['first', 'urgent', 'normal', 'low']);
});

test('a worker that stops sending heartbeats is dropped and its jobs fail with WORKER_LOST', async () => {
  const o = await orchestrator({ heartbeatTimeoutMs: 300 });
  const fake = fakeExecutor();
  // Register by hand so the "worker" can simply go silent while its API stays up.
  const w = createWorker({ id: 'quiet', port: 0, host: '127.0.0.1', token: WORKER_TOKEN, workRoot: join(tmp, 'quiet'), slots: { default: 1 }, executors: { fake: fake.executor } });
  await w.start();
  cleanups.push(() => w.stop());
  const reg = await call(o, '/v1/workers/register', { method: 'POST', token: WORKER_TOKEN, body: { id: 'quiet', url: w.url, slots: { default: 1 }, capabilities: w.capabilities } });
  assert.equal(reg.status, 200);
  const job = await client(o).submit(fakeJob('stranded'));
  await until(() => job.state === 'running');
  const snap = await job.done;
  assert.equal(snap.state, 'failed');
  assert.equal(snap.error.code, 'WORKER_LOST');
  assert.equal(o.workers.has('quiet'), false);
});

test('a heartbeat that no longer lists a dispatched job fails it with WORKER_LOST', async () => {
  const o = await orchestrator({ lostJobGraceMs: 0 });
  const { w, controls } = await worker(o, 'forgetful');
  const job = await client(o).submit(fakeJob('vanish'));
  await until(() => controls.has('vanish'));
  // Simulate a restarted worker: it forgets the job but its event stream stays open.
  w.manager.activeIds = () => [];
  const snap = await job.done;
  assert.equal(snap.error.code, 'WORKER_LOST');
  assert.match(snap.error.message, /no longer has the job/);
});

test('dispatch: a 5xx sends the job elsewhere, a 4xx fails it', async () => {
  const o = await orchestrator();
  let mode = 500;
  const { server, url } = await listen((req, res) => {
    req.resume();
    res.writeHead(mode, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOPE', message: 'nope' } }));
  });
  cleanups.push(() => close(server));
  const register = () => call(o, '/v1/workers/register', { method: 'POST', token: WORKER_TOKEN, body: { id: 'broken', url, slots: { default: 5 }, capabilities: ['type:fake'] } });
  await register();
  const fleet = client(o);

  const retried = await fleet.submit(fakeJob('retry'));
  await until(() => o.backend.get('retry').state === 'queued' && o.backend.get('retry').seq > 2);
  const good = await worker(o, 'good');
  await until(() => good.controls.has('retry'));
  good.controls.get('retry').release();
  assert.equal((await retried.done).workerId, 'good');

  mode = 400;
  await call(o, `/v1/workers/good/drain`, { method: 'POST' });
  await register();
  const rejected = await fleet.submit(fakeJob('reject'));
  const snap = await rejected.done;
  assert.equal(snap.state, 'failed');
  assert.equal(snap.error.code, 'DISPATCH_REJECTED');
});

test('drain stops new work going to a worker; GET /v1/workers describes the pool', async () => {
  const o = await orchestrator();
  const a = await worker(o, 'a');
  const b = await worker(o, 'b');
  const drained = await call(o, '/v1/workers/a/drain', { method: 'POST' });
  assert.equal(drained.body.draining, true);
  assert.equal((await call(o, '/v1/workers/zzz/drain', { method: 'POST' })).status, 404);
  const fleet = client(o);
  const job = await fleet.submit(fakeJob('d1'));
  await until(() => b.controls.has('d1'));
  assert.equal(a.controls.size, 0);
  const list = (await call(o, '/v1/workers')).body.workers;
  assert.deepEqual(list.map(w => [w.id, w.draining, w.jobs]).sort(), [['a', true, []], ['b', false, ['d1']]]);
  b.controls.get('d1').release();
  await job.done;
});

test('cancel reaches the worker; when the worker is gone the cancel is recorded anyway', async () => {
  const o = await orchestrator({ heartbeatTimeoutMs: 60000 });
  const { w, controls } = await worker(o, 'c');
  const fleet = client(o);
  const job = await fleet.submit(fakeJob('c1'));
  await until(() => controls.has('c1'));
  await job.cancel();
  assert.equal((await job.done).state, 'cancelled');
  await until(() => w.manager.get('c1').state === 'cancelled');

  const job2 = await fleet.submit(fakeJob('c2'));
  await until(() => controls.has('c2'));
  await w.stop(); // the worker disappears without the orchestrator noticing yet
  const res = await call(o, '/v1/jobs/c2', { method: 'DELETE' });
  assert.equal(res.status, 202);
  const final = await job2.done;
  assert.ok(['cancelled', 'failed'].includes(final.state));
});

test('stdin is forwarded to the worker running the job', async () => {
  const o = await orchestrator();
  await worker(o, 's', { slots: { default: 1 } });
  const fleet = client(o);
  const out = join(tmp, 'stdin.null');
  const job = await fleet.submit({ id: 'pipe', kind: 'batch', stdin: true, ffmpeg: { args: ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '2x2', '-i', 'pipe:0', '-f', 'null', out] } });
  await until(() => job.state === 'running');
  const r = await fetch(`${o.url}/v1/jobs/pipe/stdin`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(12, 255) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).bytes, 12);
  assert.equal((await call(o, '/v1/jobs/nope/stdin', { method: 'POST', body: {} })).status, 404);
  await job.cancel();
  await job.done;
});

test('s3: jobs go only to workers with S3 credentials', async () => {
  const o = await orchestrator();
  // The fake executor never touches storage; a stub client is enough to enable the scheme.
  const stubS3 = { getFile() {}, putFile() {}, putDirectory() {} };
  const plain = await worker(o, 'plain', { slots: { default: 2 } });
  const s3w = await worker(o, 's3w', { slots: { default: 2 }, s3: stubS3 });
  assert.ok(s3w.w.capabilities.includes('scheme:s3'));
  assert.ok(!plain.w.capabilities.includes('scheme:s3'));
  const fleet = client(o);
  for (const id of ['s3a', 's3b']) {
    const job = await fleet.submit(fakeJob(id, { outputs: [{ name: 'o', uri: `s3://bucket/${id}.mp4` }] }));
    await until(() => s3w.controls.has(id));
    s3w.controls.get(id).release();
    assert.equal((await job.done).workerId, 's3w');
  }
  assert.equal(plain.controls.size, 0);
});
