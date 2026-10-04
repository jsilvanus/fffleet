// Two workers behind one orchestrator, each running a live stream: one red, one green.
// Proves the streams run at the same time on different workers, that each output really
// carries its own colour, that a third stream waits for a free slot, and that cancel stops all.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFleet } from 'fffleet';
import { ORCHESTRATOR_BIN, WORKER_BIN, api, averageColor, colorStreamArgs, hlsSegments, isBlue, isGreen, isRed, startBin, tempDir, waitFor } from '../helpers/index.js';

const CLIENT_TOKEN = 'client-secret';
const WORKER_TOKEN = 'worker-secret';
const COLORS = { red: '0xFF0000', green: '0x00FF00', blue: '0x0000FF' };

let orchestrator;
const workers = [];
let tmp;
let fleet;

before(async () => {
  tmp = await tempDir();
  orchestrator = await startBin(ORCHESTRATOR_BIN, {
    FFFLEET_TOKEN: CLIENT_TOKEN,
    FFFLEET_WORKER_TOKEN: WORKER_TOKEN,
    FFFLEET_HEARTBEAT_TIMEOUT_MS: '5000',
  });
  for (const id of ['worker-a', 'worker-b']) {
    workers.push(
      await startBin(WORKER_BIN, {
        FFFLEET_WORKER_ID: id,
        FFFLEET_SLOTS: 'stream=1',
        FFFLEET_ORCHESTRATOR_URL: orchestrator.url,
        FFFLEET_WORKER_TOKEN: WORKER_TOKEN,
        FFFLEET_HEARTBEAT_MS: '500',
        FFFLEET_WORK_DIR: join(tmp.dir, `work-${id}`),
      }),
    );
  }
  await waitFor(async () => (await api(`${orchestrator.url}/v1/workers`, { token: CLIENT_TOKEN })).body?.workers?.length === 2, { message: 'two workers to register' });
  fleet = createFleet({ url: orchestrator.url, token: CLIENT_TOKEN, fallback: 'none' });
});

after(async () => {
  await fleet?.close();
  await Promise.all(workers.map(w => w.stop()));
  await orchestrator?.stop();
  await tmp?.cleanup();
});

function streamSpec(color) {
  return {
    id: `stream-${color}`,
    kind: 'stream',
    class: 'stream',
    labels: { color },
    outputs: [{ name: 'hls', uri: pathToFileURL(join(tmp.dir, color, 'index.m3u8')).href }],
    ffmpeg: { args: colorStreamArgs(COLORS[color]) },
  };
}

/** Waits until the stream has written at least `min` segments and returns the newest one's colour. */
async function liveColor(color, min = 2) {
  const playlist = join(tmp.dir, color, 'index.m3u8');
  const segments = await waitFor(async () => {
    const list = await hlsSegments(playlist);
    return list.length >= min && list;
  }, { message: `${min} HLS segments from the ${color} stream` });
  return averageColor(join(tmp.dir, color, segments.at(-1)));
}

test('two workers stream red and green at the same time', async () => {
  const red = await fleet.submit(streamSpec('red'));
  const green = await fleet.submit(streamSpec('green'));
  assert.equal(red.where, 'remote');

  const progressed = { red: false, green: false };
  red.on('progress', p => (progressed.red ||= p.outTimeMs > 0));
  green.on('progress', p => (progressed.green ||= p.outTimeMs > 0));

  await waitFor(() => red.state === 'running' && green.state === 'running', { message: 'both streams to run' });
  const [redJob, greenJob] = await Promise.all([api(`${orchestrator.url}/v1/jobs/stream-red`, { token: CLIENT_TOKEN }), api(`${orchestrator.url}/v1/jobs/stream-green`, { token: CLIENT_TOKEN })]);
  assert.ok(redJob.body.workerId, 'red has a worker');
  assert.ok(greenJob.body.workerId, 'green has a worker');
  assert.notEqual(redJob.body.workerId, greenJob.body.workerId, 'the streams run on different workers');

  // Both outputs grow at the same time and each carries its own colour.
  const [redColor, greenColor] = await Promise.all([liveColor('red'), liveColor('green')]);
  assert.ok(isRed(redColor), `red stream frame is red, got ${redColor}`);
  assert.ok(isGreen(greenColor), `green stream frame is green, got ${greenColor}`);
  // And they keep going: a later segment is still the right colour.
  const [redLater, greenLater] = await Promise.all([liveColor('red', 4), liveColor('green', 4)]);
  assert.ok(isRed(redLater) && isGreen(greenLater), `later frames keep their colours, got ${redLater} / ${greenLater}`);

  await waitFor(() => progressed.red && progressed.green, { message: 'progress events from both streams' });

  // Every stream slot is taken, so a third stream waits in the orchestrator's queue.
  const blue = await fleet.submit(streamSpec('blue'));
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(blue.state, 'queued', 'third stream waits for a slot');
  const caps = await api(`${orchestrator.url}/v1/capabilities`, { token: CLIENT_TOKEN });
  assert.deepEqual(caps.body.slots.stream, { total: 2, used: 2 });
  assert.equal(caps.body.queued, 1);

  // Stopping red frees its worker, and blue starts there.
  await red.cancel();
  const redFinal = await red.done;
  assert.equal(redFinal.state, 'cancelled');
  await waitFor(() => blue.state === 'running', { message: 'blue to start after red stops' });
  const blueJob = await api(`${orchestrator.url}/v1/jobs/stream-blue`, { token: CLIENT_TOKEN });
  assert.equal(blueJob.body.workerId, redJob.body.workerId, 'blue took the slot red freed');
  assert.ok(isBlue(await liveColor('blue')), 'blue stream frame is blue');
  assert.ok(isGreen(await liveColor('green', 1)), 'green kept streaming meanwhile');

  await Promise.all([green.cancel(), blue.cancel()]);
  const [greenFinal, blueFinal] = await Promise.all([green.done, blue.done]);
  assert.equal(greenFinal.state, 'cancelled');
  assert.equal(blueFinal.state, 'cancelled');
  assert.equal(greenFinal.error.code, 'CANCELLED');

  await waitFor(async () => {
    const { body } = await api(`${orchestrator.url}/v1/workers`, { token: CLIENT_TOKEN });
    return body.workers.every(w => (w.used.stream ?? 0) === 0 && w.jobs.length === 0);
  }, { message: 'all slots to be free again' });
});

test('the workers answer the same job API directly', async () => {
  // Each worker exposes the job API too; the orchestrator relays the same states.
  for (const w of workers) {
    const health = await api(`${w.url}/v1/health`);
    assert.equal(health.status, 200);
    const denied = await api(`${w.url}/v1/jobs`);
    assert.equal(denied.status, 401);
    const list = await api(`${w.url}/v1/jobs`, { token: WORKER_TOKEN });
    assert.equal(list.status, 200);
    assert.ok(list.body.jobs.every(j => j.state === 'cancelled'), 'worker records the cancelled streams');
  }
});
