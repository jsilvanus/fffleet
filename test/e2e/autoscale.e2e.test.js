// An orchestrator with no workers starts them on demand (as child processes), sends batch and
// stream jobs to pools of the right kind, and removes idle workers again.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORCHESTRATOR_BIN, api, averageColor, colorStreamArgs, isRed, startBin, tempDir, waitFor } from '../helpers/index.js';

const TOKEN = 'admin-secret';
let tmp, orch;

before(async () => {
  tmp = await tempDir();
  const config = join(tmp.dir, 'fffleet.yaml');
  await writeFile(config, `
autoscale:
  interval: 200ms
  scaleUpAfter: 100ms
  idleAfter: 1500ms
  bootTimeout: 30s
pools:
  - name: encoders
    provider: process
    max: 1
    kinds: [batch]
    slots: default=1
    env:
      FFFLEET_WORK_DIR: ${JSON.stringify(join(tmp.dir, 'work-batch'))}
      FFFLEET_HEARTBEAT_MS: "300"
  - name: relays
    provider: process
    max: 1
    kinds: [stream]
    slots: auto
    env:
      FFFLEET_WORK_DIR: ${JSON.stringify(join(tmp.dir, 'work-stream'))}
      FFFLEET_HEARTBEAT_MS: "300"
`);
  orch = await startBin(ORCHESTRATOR_BIN, {
    FFFLEET_CONFIG: config,
    FFFLEET_TOKEN: TOKEN,
    FFFLEET_SIGNING_KEY_FILE: join(tmp.dir, 'signing.pem'),
    FFFLEET_HEARTBEAT_TIMEOUT_MS: '3000',
  });
});

after(async () => {
  await orch?.stop();
  await tmp?.cleanup();
});

const workers = async () => (await api(`${orch.url}/v1/workers`, { token: TOKEN })).body.workers;
const pools = async () => (await api(`${orch.url}/v1/pools`, { token: TOKEN })).body.pools;
const wait = async id => waitFor(async () => {
  const j = (await api(`${orch.url}/v1/jobs/${id}`, { token: TOKEN })).body;
  return ['succeeded', 'failed', 'cancelled'].includes(j.state) ? j : null;
}, { timeoutMs: 40000, message: `job ${id}` });

test('starts with no workers and reports its pools', async () => {
  assert.equal((await workers()).length, 0);
  const p = await pools();
  assert.deepEqual(p.map(x => x.name), ['encoders', 'relays']);
  assert.equal(p[0].instances, 0);
});

test('a batch job starts a batch worker, which is removed again when idle', async () => {
  const out = join(tmp.dir, 'red.png');
  const res = await api(`${orch.url}/v1/jobs`, {
    method: 'POST',
    token: TOKEN,
    body: {
      kind: 'batch',
      outputs: [{ name: 'img', uri: pathToFileURL(out).href }],
      ffmpeg: { args: ['-f', 'lavfi', '-i', 'color=c=0xFF0000:s=64x48:d=0.2', '-frames:v', '1', '{{output:img}}'], durationMs: 200 },
    },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const job = await wait(res.body.id);
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.ok(isRed(await averageColor(out)));

  const [w] = await workers();
  assert.deepEqual(w.kinds, ['batch']);
  assert.match(w.id, /^encoders-/);
  await waitFor(async () => (await workers()).length === 0, { timeoutMs: 20000, message: 'the idle worker to be removed' });
  assert.equal((await pools())[0].instances, 0);
});

test('a stream job goes to the stream pool, never the batch pool', async () => {
  const hls = join(tmp.dir, 'live', 'index.m3u8');
  const res = await api(`${orch.url}/v1/jobs`, {
    method: 'POST',
    token: TOKEN,
    body: {
      kind: 'stream',
      outputs: [{ name: 'hls', uri: pathToFileURL(hls).href }],
      ffmpeg: { args: colorStreamArgs('red') },
    },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await waitFor(async () => (await workers()).some(w => w.jobs.length), { timeoutMs: 30000, message: 'the stream job to run' });
  const ws = await workers();
  assert.equal(ws.length, 1);
  assert.match(ws[0].id, /^relays-/);
  assert.deepEqual(ws[0].kinds, ['stream']);
  await api(`${orch.url}/v1/jobs/${res.body.id}`, { method: 'DELETE', token: TOKEN });
  await waitFor(async () => (await workers()).length === 0, { timeoutMs: 20000, message: 'the stream worker to be removed' });
});
