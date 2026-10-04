import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobManager, normalizeSlots, normalizeKinds, autoSlots } from '../src/index.js';
import { averageColor, collect, fakeExecutor, fakeSpec, near, tempDir, tick, until } from './helpers.js';

const tmp = await tempDir();
after(() => tmp.cleanup());

function manager(opts = {}) {
  const fake = fakeExecutor();
  const m = new JobManager({ workRoot: join(tmp.dir, 'work'), executors: { fake: fake.executor }, ...opts });
  return { m, ...fake };
}

test('normalizeSlots parses strings and rejects nonsense', () => {
  assert.deepEqual(normalizeSlots('default=2, stream=1'), { default: 2, stream: 1 });
  assert.deepEqual(normalizeSlots({ gpu: '1' }), { gpu: 1 });
  assert.throws(() => normalizeSlots('default=-1'));
  assert.throws(() => normalizeSlots('Bad=1'));
  assert.throws(() => normalizeSlots({}));
});

test('slots: auto sizes pools from the CPU count and the kinds', () => {
  assert.deepEqual(autoSlots({ cpus: 8, kinds: ['batch'] }), { default: 4 });
  assert.deepEqual(autoSlots({ cpus: 8, kinds: ['stream'] }), { default: 8 });
  assert.deepEqual(autoSlots({ cpus: 8, kinds: ['stream', 'batch'] }), { default: 4, stream: 2 });
  assert.deepEqual(autoSlots({ cpus: 1, kinds: ['batch'] }), { default: 1 });
  assert.deepEqual(normalizeSlots('auto:4', { cpus: 16, kinds: ['batch'] }), { default: 4 });
  assert.deepEqual(normalizeSlots('auto:1', { cpus: 6, kinds: ['stream', 'batch'] }), { default: 6 });
  assert.deepEqual(normalizeSlots('auto', { cpus: 8, kinds: ['batch'] }), { default: 4 });
  assert.throws(() => normalizeSlots('auto:0'), /above 0/);
});

test('kinds: parsed, defaulted and enforced', async () => {
  assert.deepEqual([...normalizeKinds('batch')], ['batch']);
  assert.deepEqual([...normalizeKinds(undefined)].sort(), ['batch', 'stream']);
  assert.throws(() => normalizeKinds('video'), /invalid job kind/);
  const { m } = manager({ kinds: ['batch'], slots: { default: 1 } });
  assert.throws(() => m.submit({ ...fakeSpec('s'), kind: 'stream' }), err => err.status === 422 && err.code === 'UNSUPPORTED_KIND');
  await m.close();
});

test('runs up to the slot count and queues the rest', async () => {
  const { m, controls, started } = manager({ slots: { default: 2 } });
  for (const id of ['a', 'b', 'c']) m.submit(fakeSpec(id));
  await until(() => started.length === 2);
  await tick();
  // Both start at once; which executor call lands first is not defined.
  assert.deepEqual([...started].sort(), ['a', 'b']);
  assert.equal(m.get('c').state, 'queued');
  assert.deepEqual(m.stats(), { pools: { default: { total: 2, used: 2 } }, queued: 1, running: 2 });
  controls.get('a').release();
  await until(() => started.length === 3);
  assert.equal(started[2], 'c');
  assert.equal(m.get('a').state, 'succeeded');
  await m.close();
});

test('a class with its own pool does not use the default pool, and the reverse', async () => {
  const { m, started } = manager({ slots: { default: 1, stream: 1 } });
  m.submit(fakeSpec('s1', { class: 'stream' }));
  m.submit(fakeSpec('s2', { class: 'stream' }));
  m.submit(fakeSpec('d1'));
  m.submit(fakeSpec('other', { class: 'other' })); // no own pool -> default
  await until(() => started.length === 2);
  await tick();
  assert.deepEqual(started.sort(), ['d1', 's1']);
  assert.equal(m.get('s2').state, 'queued');
  assert.equal(m.get('other').state, 'queued');
  await m.close();
});

test('higher priority jobs leave the queue first', async () => {
  const { m, controls, started } = manager({ slots: { default: 1 } });
  m.submit(fakeSpec('busy'));
  m.submit(fakeSpec('low', { priority: -5 }));
  m.submit(fakeSpec('mid'));
  m.submit(fakeSpec('high', { priority: 5 }));
  await until(() => controls.has('busy'));
  for (const next of ['busy', 'high', 'mid']) {
    controls.get(next).release();
    const n = started.length;
    await until(() => started.length === n + 1);
  }
  assert.deepEqual(started, ['busy', 'high', 'mid', 'low']);
  await m.close();
});

test('submit is idempotent by id and rejects a different spec with the same id', async () => {
  const { m } = manager();
  const first = m.submit(fakeSpec('same', { labels: { a: 'b' } }));
  const again = m.submit(fakeSpec('same', { labels: { a: 'b' } }));
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.throws(() => m.submit(fakeSpec('same', { labels: { a: 'c' } })), { code: 'ID_CONFLICT', status: 409 });
  await m.close();
});

test('submit errors: unknown type, class without slots, full queue, closed', async () => {
  const { m } = manager({ slots: { default: 1, gpu: 0 }, maxQueued: 1 });
  assert.throws(() => m.submit({ kind: 'batch', type: 'nothing' }), { code: 'UNSUPPORTED_TYPE', status: 422 });
  assert.throws(() => m.submit(fakeSpec('g', { class: 'gpu' })), { code: 'NO_SLOTS', status: 422 });
  assert.throws(() => m.submit({ kind: 'batch' }), { code: 'INVALID_SPEC', status: 422 });
  m.submit(fakeSpec('run'));
  m.submit(fakeSpec('wait'));
  assert.throws(() => m.submit(fakeSpec('over')), { code: 'QUEUE_FULL', status: 503 });
  await m.close();
  assert.throws(() => m.submit(fakeSpec('late')), { code: 'SHUTTING_DOWN', status: 503 });
});

test('cancel works on queued and running jobs and frees the slot', async () => {
  const { m, started, controls } = manager({ slots: { default: 1 } });
  m.submit(fakeSpec('run'));
  m.submit(fakeSpec('wait'));
  m.submit(fakeSpec('next'));
  await until(() => controls.has('run'));
  assert.equal(m.cancel('wait').state, 'cancelled');
  const { done } = collect(m, 'run');
  m.cancel('run');
  const events = await done;
  assert.equal(events.at(-1).state, 'cancelled');
  assert.equal(events.at(-1).error.code, 'CANCELLED');
  await until(() => started.length === 2);
  assert.deepEqual(started, ['run', 'next']);
  assert.equal(m.cancel('nope'), null);
  await m.close();
});

test('timeoutMs fails a job with TIMEOUT', async () => {
  const { m } = manager();
  m.submit(fakeSpec('slow', { timeoutMs: 50 }));
  const events = await collect(m, 'slow').done;
  assert.equal(events.at(-1).state, 'failed');
  assert.equal(events.at(-1).error.code, 'TIMEOUT');
  await m.close();
});

test('an executor error fails the job with its code', async () => {
  const { m, controls } = manager();
  m.submit(fakeSpec('bad'));
  await until(() => controls.has('bad'));
  const err = Object.assign(new Error('boom'), { code: 'FFMPEG_EXIT', details: { exitCode: 1, stderrTail: 'oops' } });
  controls.get('bad').fail(err);
  const final = (await collect(m, 'bad').done).at(-1);
  assert.deepEqual([final.state, final.error.code, final.exitCode, final.stderrTail], ['failed', 'FFMPEG_EXIT', 1, 'oops']);
  await m.close();
});

test('activeIds lists unfinished jobs; keepFinished bounds memory', async () => {
  const { m, controls } = manager({ slots: { default: 5 }, keepFinished: 1 });
  for (const id of ['a', 'b', 'c']) m.submit(fakeSpec(id));
  await until(() => controls.size === 3);
  controls.get('a').release();
  controls.get('b').release();
  await until(() => m.activeIds().length === 1);
  assert.deepEqual(m.activeIds(), ['c']);
  m.submit(fakeSpec('d'));
  assert.equal(m.get('a'), null, 'oldest finished job forgotten');
  assert.equal(m.get('b').state, 'succeeded');
  await m.close();
});

test('real ffmpeg: a batch job writes a red frame', async () => {
  const m = new JobManager({ workRoot: join(tmp.dir, 'work') });
  const out = join(tmp.dir, 'red.png');
  m.submit({ id: 'red', kind: 'batch', outputs: [{ name: 'img', uri: pathToFileURL(out).href }], ffmpeg: { args: ['-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=0.5', '-frames:v', '1', '{{output:img}}'], durationMs: 40 } });
  const final = (await collect(m, 'red').done).at(-1);
  assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  assert.equal(final.exitCode, 0);
  assert.ok(final.outputs[0].bytes > 0);
  assert.ok(near(await averageColor(out), [255, 0, 0]));
  assert.equal(existsSync(join(tmp.dir, 'work', 'red')), false, 'work dir removed');
  await m.close();
});

test('real ffmpeg: a bad argument fails with FFMPEG_EXIT and a stderr tail', async () => {
  const m = new JobManager({ workRoot: join(tmp.dir, 'work') });
  m.submit({ id: 'broken', kind: 'batch', ffmpeg: { args: ['-f', 'lavfi', '-i', 'nosuchsource', '-f', 'null', '-'] } });
  const final = (await collect(m, 'broken').done).at(-1);
  assert.equal(final.state, 'failed');
  assert.equal(final.error.code, 'FFMPEG_EXIT');
  assert.notEqual(final.exitCode, 0);
  assert.match(final.stderrTail, /nosuchsource/);
  await m.close();
});

test('real ffmpeg: stdin feeds a running job', async () => {
  const m = new JobManager({ workRoot: join(tmp.dir, 'work') });
  const out = join(tmp.dir, 'from-stdin.png');
  // A raw 2x2 green rgb24 frame arrives on stdin.
  m.submit({ id: 'stdin', kind: 'batch', stdin: true, outputs: [{ name: 'img', uri: pathToFileURL(out).href }], ffmpeg: { args: ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '2x2', '-i', 'pipe:0', '-frames:v', '1', '{{output:img}}'] } });
  const { done } = collect(m, 'stdin');
  await assert.rejects(m.writeStdin('nope', Buffer.alloc(1)), { code: 'NOT_FOUND' });
  // Wait for ffmpeg to start before writing.
  for (let i = 0; i < 100 && m.get('stdin').state !== 'running'; i++) await tick(20);
  const frame = Buffer.from(Array(4).fill([0, 255, 0]).flat());
  assert.deepEqual(await m.writeStdin('stdin', frame), { bytes: 12 });
  m.jobs.get('stdin').run.stdin.end();
  const final = (await done).at(-1);
  assert.equal(final.state, 'succeeded', JSON.stringify(final));
  assert.ok(near(await averageColor(out), [0, 255, 0]));
  await m.close();
});

test('writeStdin refuses a job without stdin', async () => {
  const { m } = manager();
  m.submit(fakeSpec('x'));
  await assert.rejects(m.writeStdin('x', Buffer.from('a')), { code: 'NO_STDIN', status: 409 });
  await m.close();
});
