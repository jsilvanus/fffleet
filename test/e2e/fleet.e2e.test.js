// Fleet behaviour across real processes: routing by capability, drain, a worker that dies
// mid-stream, and a client that falls back to running jobs itself.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFleet } from 'fffleet';
import { ORCHESTRATOR_BIN, WORKER_BIN, api, averageColor, colorStreamArgs, isBlue, isGreen, isRed, startBin, tempDir, waitFor } from '../helpers/index.js';

const TOKEN = 'secret';
let orchestrator;
const workers = {};
let tmp;
let fleet;

async function startWorker(id, env = {}) {
  workers[id] = await startBin(WORKER_BIN, {
    FFFLEET_WORKER_ID: id,
    FFFLEET_SLOTS: 'default=1,stream=1',
    FFFLEET_ORCHESTRATOR_URL: orchestrator.url,
    FFFLEET_WORKER_TOKEN: TOKEN,
    FFFLEET_HEARTBEAT_MS: '300',
    FFFLEET_WORK_DIR: join(tmp.dir, `work-${id}`),
    ...env,
  });
}

const listWorkers = async () => (await api(`${orchestrator.url}/v1/workers`, { token: TOKEN })).body.workers;

before(async () => {
  tmp = await tempDir();
  orchestrator = await startBin(ORCHESTRATOR_BIN, { FFFLEET_TOKEN: TOKEN, FFFLEET_WORKER_TOKEN: TOKEN, FFFLEET_HEARTBEAT_TIMEOUT_MS: '1500' });
  await startWorker('alpha');
  await startWorker('beta', { FFFLEET_CAPABILITIES: 'site:beta' });
  await waitFor(async () => (await listWorkers()).length === 2, { message: 'workers to register' });
  fleet = createFleet({ url: orchestrator.url, token: TOKEN, fallback: 'none' });
});

after(async () => {
  await fleet?.close();
  await Promise.all(Object.values(workers).map(w => w.stop('SIGKILL')));
  await orchestrator?.stop();
  await tmp?.cleanup();
});

const frameJob = (color, extra = {}) => ({
  kind: 'batch',
  outputs: [{ name: 'img', uri: pathToFileURL(join(tmp.dir, `${color}-${Math.random().toString(36).slice(2)}.png`)).href }],
  ffmpeg: { args: ['-f', 'lavfi', '-i', `color=c=${color}:s=64x48:d=0.2`, '-frames:v', '1', '{{output:img}}'], durationMs: 200 },
  ...extra,
});

test('a batch job runs on a worker and writes its output', async () => {
  const job = await fleet.submit(frameJob('0xFF0000'));
  const done = await job.done;
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.ok(['alpha', 'beta'].includes(done.workerId));
  assert.equal(done.outputs.length, 1);
  assert.ok(done.outputs[0].bytes > 0);
  assert.ok(isRed(await averageColor(fileURLToPath(new URL(done.outputs[0].uri)))));
});

test('requires routes a job only to a worker with that capability', async () => {
  for (let i = 0; i < 3; i++) {
    const done = await (await fleet.submit(frameJob('0x00FF00', { requires: ['site:beta'] }))).done;
    assert.equal(done.state, 'succeeded');
    assert.equal(done.workerId, 'beta');
    assert.ok(isGreen(await averageColor(fileURLToPath(new URL(done.outputs[0].uri)))));
  }
});

test('a job no worker can satisfy waits in the queue until cancelled', async () => {
  const job = await fleet.submit(frameJob('0x0000FF', { requires: ['site:nowhere'] }));
  await new Promise(r => setTimeout(r, 800));
  assert.equal(job.state, 'queued');
  await job.cancel();
  assert.equal((await job.done).state, 'cancelled');
});

test('the queue runs higher priority first', async () => {
  // Fill both stream slots, then queue a low and a high priority stream.
  const busy = await Promise.all(['a', 'b'].map(n => fleet.submit({ id: `busy-${n}`, kind: 'stream', class: 'stream', outputs: [{ name: 'hls', uri: pathToFileURL(join(tmp.dir, `busy-${n}`, 'i.m3u8')).href }], ffmpeg: { args: colorStreamArgs('0xFF0000') } })));
  await waitFor(() => busy.every(j => j.state === 'running'), { message: 'busy streams to run' });
  const spec = (id, priority) => ({ id, priority, kind: 'stream', class: 'stream', outputs: [{ name: 'hls', uri: pathToFileURL(join(tmp.dir, id, 'i.m3u8')).href }], ffmpeg: { args: colorStreamArgs('0x0000FF') } });
  const low = await fleet.submit(spec('low', 0));
  const high = await fleet.submit(spec('high', 10));
  await busy[0].cancel();
  await waitFor(() => high.state === 'running', { message: 'high priority to start first' });
  assert.equal(low.state, 'queued');
  await Promise.all([busy[1].cancel(), high.cancel(), low.cancel()]);
  await Promise.all([busy[0].done, busy[1].done, high.done, low.done]);
});

test('a drained worker gets no new jobs', async () => {
  const res = await api(`${orchestrator.url}/v1/workers/alpha/drain`, { method: 'POST', token: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.body.draining, true);
  for (let i = 0; i < 2; i++) {
    const done = await (await fleet.submit(frameJob('0xFF0000'))).done;
    assert.equal(done.workerId, 'beta');
  }
});

test('a worker that dies mid-stream fails its job with WORKER_LOST and the fleet carries on', async () => {
  const job = await fleet.submit({ id: 'doomed', kind: 'stream', class: 'stream', outputs: [{ name: 'hls', uri: pathToFileURL(join(tmp.dir, 'doomed', 'i.m3u8')).href }], ffmpeg: { args: colorStreamArgs('0x0000FF') } });
  await waitFor(() => job.state === 'running', { message: 'stream to run' });
  assert.equal(job.snapshot.workerId ?? (await api(`${orchestrator.url}/v1/jobs/doomed`, { token: TOKEN })).body.workerId, 'beta');

  await workers.beta.stop('SIGKILL');
  const done = await job.done;
  assert.equal(done.state, 'failed');
  assert.equal(done.error.code, 'WORKER_LOST');
  await waitFor(async () => !(await listWorkers()).some(w => w.id === 'beta'), { message: 'beta to be dropped' });

  // A fresh worker joins and takes new work.
  await startWorker('gamma');
  const next = await (await fleet.submit(frameJob('0x0000FF'))).done;
  assert.equal(next.state, 'succeeded');
  assert.equal(next.workerId, 'gamma');
  assert.ok(isBlue(await averageColor(fileURLToPath(new URL(next.outputs[0].uri)))));
});

test('with fallback "local" a client runs the job itself when the fleet is unreachable', async () => {
  const offline = createFleet({ url: 'http://127.0.0.1:9', token: TOKEN, local: { workRoot: join(tmp.dir, 'local') } });
  try {
    const job = await offline.submit(frameJob('0x00FF00'));
    assert.equal(job.where, 'local');
    const done = await job.done;
    assert.equal(done.state, 'succeeded');
    assert.ok(isGreen(await averageColor(fileURLToPath(new URL(done.outputs[0].uri)))));
  } finally {
    await offline.close();
  }
  const strict = createFleet({ url: 'http://127.0.0.1:9', fallback: 'none' });
  await assert.rejects(strict.submit(frameJob('0x00FF00')));
});
