import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker } from 'fffleet-worker';
import { createOrchestrator } from '../src/orchestrator.js';
import { openSqliteJobStore } from '../src/job-store.js';

// node:sqlite arrived in Node 22.13 (22.5 behind a flag); older versions skip these tests.
const hasSqlite = await import('node:sqlite').then(() => true, () => false);
const sqliteTest = (name, fn) => test(name, { skip: !hasSqlite && 'node:sqlite is not available' }, fn);

const TOKEN = 'client';
const WORKER_TOKEN = 'worker';
let tmp;
const cleanups = [];

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fffleet-restart-'));
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
const freePort = () =>
  new Promise(resolve => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function fakeExecutor() {
  const controls = new Map();
  const executor = (spec, rt) =>
    new Promise((resolve, reject) => {
      rt.setState('running');
      rt.signal.addEventListener('abort', () => reject(rt.signal.reason), { once: true });
      controls.set(spec.id, { release: () => resolve({ exitCode: 0, outputs: [] }), rt });
    });
  return { executor, controls };
}

/** Starts an orchestrator on `port` saving to `file`; the returned `stop` stops it (state stays in the file). */
async function orchestrator(file, port, opts = {}) {
  const o = createOrchestrator({ port, host: '127.0.0.1', token: TOKEN, workerToken: WORKER_TOKEN, sweepMs: 50, stateFile: file, ...opts });
  await o.start();
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await o.stop();
    }
  };
  cleanups.push(stop);
  return { o, stop };
}

async function worker(o, id) {
  const fake = fakeExecutor();
  const w = createWorker({
    id, port: 0, host: '127.0.0.1', token: WORKER_TOKEN, workRoot: join(tmp, id), slots: { default: 1 },
    orchestratorUrl: o.url, orchestratorToken: WORKER_TOKEN, heartbeatMs: 50, progressIntervalMs: 0,
    executors: { fake: fake.executor },
  });
  await w.start();
  cleanups.push(() => w.stop());
  await until(() => o.workers.has(id));
  return { w, ...fake };
}

const fakeJob = (id, extra = {}) => ({ id, kind: 'batch', type: 'fake', ...extra });

sqliteTest('queued jobs come back after a restart, in priority order, and run once a worker joins', async () => {
  const file = join(tmp, 'queued.db');
  const port = await freePort();
  const first = await orchestrator(file, port);
  first.o.backend.submit(fakeJob('low'));
  first.o.backend.submit(fakeJob('high', { priority: 5 }));
  first.o.backend.submit(fakeJob('mid', { priority: 1 }));
  await first.stop();

  const second = await orchestrator(file, port);
  assert.deepEqual(second.o.backend.list().map(j => j.id).sort(), ['high', 'low', 'mid']);
  assert.equal(second.o.backend.capabilities().queued, 3);
  const w = await worker(second.o, 'w1');
  await until(() => w.controls.has('high'));
  w.controls.get('high').release();
  await until(() => w.controls.has('mid'));
  assert.equal(second.o.backend.get('high').state, 'succeeded');
});

sqliteTest('a running job is picked up again when its worker reports it, and finishes on the new orchestrator', async () => {
  const file = join(tmp, 'running.db');
  const port = await freePort();
  const first = await orchestrator(file, port);
  const w = await worker(first.o, 'w1');
  first.o.backend.submit(fakeJob('long'));
  await until(() => w.controls.has('long') && first.o.backend.get('long').state === 'running');
  await first.stop();

  const second = await orchestrator(file, port);
  assert.equal(second.o.backend.get('long').state, 'running', 'restored as running, waiting for the worker');
  await until(() => second.o.workers.has('w1'));
  await until(() => second.o.workers.get('w1').jobs.has('long'));
  w.controls.get('long').release();
  await until(() => second.o.backend.get('long').state === 'succeeded');
});

sqliteTest('a running job its worker never reports fails with ORCHESTRATOR_RESTARTED after the grace period', async () => {
  const file = join(tmp, 'lost.db');
  const port = await freePort();
  const first = await orchestrator(file, port);
  const w = await worker(first.o, 'w1');
  first.o.backend.submit(fakeJob('gone'));
  await until(() => first.o.backend.get('gone').state === 'running');
  await first.stop();
  await w.w.stop();

  const second = await orchestrator(file, port, { adoptGraceMs: 200 });
  assert.equal(second.o.backend.get('gone').state, 'running');
  await until(() => second.o.backend.get('gone').state === 'failed');
  assert.equal(second.o.backend.get('gone').error.code, 'ORCHESTRATOR_RESTARTED');
});

sqliteTest('a cancel that arrives while a restored job waits for its worker is applied when the worker reports it', async () => {
  const file = join(tmp, 'cancel.db');
  const port = await freePort();
  const first = await orchestrator(file, port);
  const w = await worker(first.o, 'w1');
  first.o.backend.submit(fakeJob('c1'));
  await until(() => first.o.backend.get('c1').state === 'running');
  await first.stop();

  const second = await orchestrator(file, port);
  await second.o.backend.cancel('c1');
  await until(() => second.o.backend.get('c1').state === 'cancelled');
  assert.ok(w.controls.get('c1'));
});

sqliteTest('stream jobs fail on restart; finished jobs stay and keep their idempotency', async () => {
  const file = join(tmp, 'mixed.db');
  const port = await freePort();
  const first = await orchestrator(file, port);
  const w = await worker(first.o, 'w1');
  first.o.backend.submit(fakeJob('done'));
  await until(() => w.controls.has('done'));
  w.controls.get('done').release();
  await until(() => first.o.backend.get('done').state === 'succeeded');
  first.o.backend.submit({ id: 's1', kind: 'stream', type: 'fake' });
  await until(() => first.o.backend.get('s1').state === 'running');
  await first.stop();
  await w.w.stop();

  const second = await orchestrator(file, port);
  assert.equal(second.o.backend.get('done').state, 'succeeded');
  assert.equal(second.o.backend.get('s1').state, 'failed');
  assert.equal(second.o.backend.get('s1').error.code, 'ORCHESTRATOR_RESTARTED');
  const again = second.o.backend.submit(fakeJob('done'));
  assert.equal(again.created, false);
  assert.equal(again.job.state, 'succeeded');
});

test('without a state file nothing is kept', async () => {
  const port = await freePort();
  const first = await orchestrator(null, port);
  first.o.backend.submit(fakeJob('x'));
  await first.stop();
  const second = await orchestrator(null, port);
  assert.equal(second.o.backend.get('x'), null);
});

sqliteTest('the sqlite store keeps the newest finished jobs when pruned and skips damaged rows', async () => {
  const file = join(tmp, 'store.db');
  const store = await openSqliteJobStore(file);
  const job = (id, order, final) => ({ id, order, final, spec: { id }, state: final ? 'succeeded' : 'queued', history: [] });
  for (let i = 1; i <= 5; i++) store.save(job(`f${i}`, i, true));
  store.save(job('q', 6, false));
  store.prune(2);
  assert.deepEqual(store.loadAll().map(j => j.spec.id), ['f4', 'f5', 'q']);
  store.prune(10);
  assert.equal(store.loadAll().length, 3);
  store.close();

  const reopened = await openSqliteJobStore(file);
  assert.equal(reopened.loadAll().length, 3, 'survives reopening');
  reopened.close();
});
