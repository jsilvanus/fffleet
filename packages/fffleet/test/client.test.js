import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { JobManager, createFleet } from '../src/index.js';
import { close, createApiHandler, listen } from '../src/server.js';
import { fakeExecutor, fakeSpec, tempDir, until } from './helpers.js';

let tmp;
before(async () => {
  tmp = await tempDir();
});
after(() => tmp.cleanup());

async function remoteServer({ token = 'tok', fail503 = false } = {}) {
  const fake = fakeExecutor();
  const manager = new JobManager({ workRoot: join(tmp.dir, 'remote'), executors: { fake: fake.executor }, progressIntervalMs: 0 });
  const backend = {
    submit: s => {
      if (fail503) throw Object.assign(new Error('busy'), { status: 503, code: 'QUEUE_FULL' });
      return manager.submit(s);
    },
    get: id => manager.get(id),
    list: () => manager.list(),
    cancel: id => manager.cancel(id),
    writeStdin: (id, d) => manager.writeStdin(id, d),
    subscribe: (id, a, fn) => manager.subscribe(id, a, fn),
    capabilities: () => ({ role: 'test' }),
  };
  const { server, url } = await listen(createApiHandler({ backend, token }));
  return { url, fake, manager, stop: async () => { await manager.close(); await close(server); } };
}

test('without a url jobs run locally', async () => {
  const fake = fakeExecutor();
  const fleet = createFleet({ local: { workRoot: join(tmp.dir, 'l1'), executors: { fake: fake.executor } } });
  assert.equal(fleet.mode, 'local');
  const job = await fleet.submit(fakeSpec('loc'));
  assert.equal(job.where, 'local');
  const states = [];
  job.on('state', s => states.push(s));
  await until(() => fake.controls.has('loc'));
  fake.controls.get('loc').release();
  const snap = await job.done;
  assert.equal(snap.state, 'succeeded');
  assert.deepEqual(states, ['running', 'succeeded']);
  await fleet.close();
});

test('the client gives every job an id so a retry cannot run it twice', async () => {
  const fake = fakeExecutor();
  const fleet = createFleet({ local: { workRoot: join(tmp.dir, 'l2'), executors: { fake: fake.executor } } });
  const job = await fleet.submit({ kind: 'batch', type: 'fake' });
  assert.match(job.id, /^job_[0-9a-f-]{36}$/);
  await fleet.close();
});

test('invalid specs are rejected before anything is sent', async () => {
  const fleet = createFleet({ url: 'http://127.0.0.1:9' });
  await assert.rejects(fleet.submit({ kind: 'bogus' }), { code: 'INVALID_SPEC' });
});

test('remote: follows events, cancels and writes through the API', async () => {
  const srv = await remoteServer();
  const fleet = createFleet({ url: srv.url, token: 'tok', fallback: 'none' });
  try {
    assert.equal(fleet.mode, 'remote');
    assert.deepEqual(await fleet.capabilities(), { role: 'test' });
    const job = await fleet.submit(fakeSpec('r1'));
    assert.equal(job.where, 'remote');
    const progress = [];
    job.on('progress', p => progress.push(p.pct));
    await until(() => job.state === 'running');
    srv.fake.controls.get('r1').rt.progress({ pct: 42 });
    await until(() => progress.length === 1);
    srv.fake.controls.get('r1').release();
    const snap = await job.done;
    assert.equal(snap.state, 'succeeded');
    assert.deepEqual(progress, [42, 100], "final event reports 100%");

    const job2 = await fleet.submit(fakeSpec('r2'));
    await assert.rejects(job2.write('x'), { code: 'NO_STDIN', status: 409 });
    await job2.cancel();
    assert.equal((await job2.done).state, 'cancelled');
  } finally {
    await fleet.close();
    await srv.stop();
  }
});

test('remote: a wrong token is an error, never a fallback', async () => {
  const srv = await remoteServer();
  const fleet = createFleet({ url: srv.url, token: 'wrong', local: { workRoot: join(tmp.dir, 'l3') } });
  try {
    await assert.rejects(fleet.submit(fakeSpec('auth')), { status: 401 });
  } finally {
    await fleet.close();
    await srv.stop();
  }
});

test('fallback "local" takes over when the remote is unreachable or answers 503', async () => {
  for (const setup of ['unreachable', '503']) {
    const srv = setup === '503' ? await remoteServer({ fail503: true }) : null;
    const fake = fakeExecutor();
    const fleet = createFleet({ url: srv?.url ?? 'http://127.0.0.1:9', token: 'tok', local: { workRoot: join(tmp.dir, `fb-${setup}`), executors: { fake: fake.executor } } });
    try {
      const job = await fleet.submit(fakeSpec(`fb-${setup}`));
      assert.equal(job.where, 'local', setup);
      await until(() => fake.controls.has(`fb-${setup}`));
      fake.controls.get(`fb-${setup}`).release();
      assert.equal((await job.done).state, 'succeeded');
    } finally {
      await fleet.close();
      await srv?.stop();
    }
  }
});

test('fallback "none" surfaces the error', async () => {
  const srv = await remoteServer({ fail503: true });
  const fleet = createFleet({ url: srv.url, token: 'tok', fallback: 'none' });
  try {
    await assert.rejects(fleet.submit(fakeSpec('nf')), { status: 503 });
    await assert.rejects(createFleet({ url: 'http://127.0.0.1:9', fallback: 'none' }).submit(fakeSpec('nf2')));
  } finally {
    await srv.stop();
  }
});

test('job.stdout() reads ffmpeg output from a local job', async () => {
  const fleet = createFleet();
  const job = await fleet.submit({ id: 'stdout-local', kind: 'stream', stdout: true, ffmpeg: { args: ['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.25', '-f', 's16le', 'pipe:1'] } });
  const chunks = [];
  for await (const c of await job.stdout()) chunks.push(c);
  assert.equal(Buffer.concat(chunks).length, 4000);
  assert.equal((await job.done).state, 'succeeded');
  await fleet.close();
});
