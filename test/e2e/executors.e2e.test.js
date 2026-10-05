// A worker started with FFFLEET_EXECUTORS runs a job type that is not ffmpeg, behind an orchestrator.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFleet } from 'fffleet';
import { ORCHESTRATOR_BIN, WORKER_BIN, api, startBin, tempDir, waitFor } from '../helpers/index.js';

const TOKEN = 'client-secret';
const WORKER_TOKEN = 'worker-secret';
let tmp, orchestrator, worker, fleet;

before(async () => {
  tmp = await tempDir();
  orchestrator = await startBin(ORCHESTRATOR_BIN, { FFFLEET_TOKEN: TOKEN, FFFLEET_WORKER_TOKEN: WORKER_TOKEN });
  worker = await startBin(WORKER_BIN, {
    FFFLEET_WORKER_ID: 'echo-worker',
    FFFLEET_ORCHESTRATOR_URL: orchestrator.url,
    FFFLEET_WORKER_TOKEN: WORKER_TOKEN,
    FFFLEET_HEARTBEAT_MS: '300',
    FFFLEET_WORK_DIR: join(tmp.dir, 'work'),
    FFFLEET_EXECUTORS: fileURLToPath(new URL('../fixtures/echo-executor.js', import.meta.url)),
  });
  await waitFor(async () => (await api(`${orchestrator.url}/v1/workers`, { token: TOKEN })).body?.workers?.length === 1, { message: 'the worker to register' });
  fleet = createFleet({ url: orchestrator.url, token: TOKEN, fallback: 'none' });
});

after(async () => {
  await fleet?.close();
  await worker?.stop();
  await orchestrator?.stop();
  await tmp?.cleanup();
});

test('the worker claims type:echo and runs the job until it is cancelled', async () => {
  const caps = (await api(`${orchestrator.url}/v1/capabilities`, { token: TOKEN })).body.capabilities;
  assert.ok(caps.includes('type:echo'), caps.join());
  const job = await fleet.submit({ id: 'echo-1', kind: 'stream', type: 'echo', echo: { hello: 'world' } });
  await waitFor(() => job.state === 'running', { message: 'the job to run' });
  await job.cancel();
  assert.equal((await job.done).state, 'cancelled');
});

test('an unknown type is not routed anywhere', async () => {
  const job = await fleet.submit({ id: 'nope-1', kind: 'batch', type: 'nope', nope: {} }).catch(err => err);
  // Either rejected up front or left queued: it must never run.
  if (job instanceof Error) return;
  await new Promise(r => setTimeout(r, 800));
  assert.equal(job.state, 'queued');
  await job.cancel();
});
