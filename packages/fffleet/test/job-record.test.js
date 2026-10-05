import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobRecord, byPriority, parseSpec, pruneFinished } from '../src/index.js';

const spec = (extra = {}) => parseSpec({ id: 'j', kind: 'batch', ffmpeg: { args: ['x'] }, ...extra });

test('starts queued with seq 1 and moves through states', () => {
  const r = new JobRecord(spec());
  assert.equal(r.state, 'queued');
  assert.equal(r.seq, 1);
  r.push({ state: 'running' });
  r.push({ progress: { pct: 10 } });
  r.push({ state: 'succeeded', exitCode: 0, outputs: [] });
  const s = r.snapshot();
  assert.equal(s.state, 'succeeded');
  assert.equal(s.seq, 4);
  assert.ok(s.startedAt && s.finishedAt);
  assert.deepEqual(s.progress, { pct: 10 });
});

test('a job is final exactly once', () => {
  const r = new JobRecord(spec());
  r.push({ state: 'failed', error: { code: 'X', message: 'x' } });
  assert.equal(r.push({ state: 'succeeded' }), null);
  assert.equal(r.snapshot().state, 'failed');
  assert.equal(r.snapshot().error.code, 'X');
});

test('subscribe replays history after a seq, then follows', () => {
  const r = new JobRecord(spec());
  r.push({ state: 'running' });
  const got = [];
  const off = r.subscribe(1, e => got.push(e.seq));
  r.push({ state: 'succeeded' });
  off();
  assert.deepEqual(got, [2, 3]);
});

test('byPriority puts higher priority first, then submission order', () => {
  const a = new JobRecord(spec({ id: 'a' }));
  const b = new JobRecord(spec({ id: 'b', priority: 5 }));
  const c = new JobRecord(spec({ id: 'c' }));
  assert.deepEqual([a, c, b].sort(byPriority).map(r => r.id), ['b', 'a', 'c']);
});

test('pruneFinished drops the oldest finished jobs only', () => {
  const jobs = new Map();
  for (const id of ['f1', 'live', 'f2', 'f3']) {
    const r = new JobRecord(spec({ id }));
    if (id !== 'live') r.push({ state: 'succeeded' });
    jobs.set(id, r);
  }
  pruneFinished(jobs, 1);
  assert.deepEqual([...jobs.keys()], ['live', 'f3']);
});

test('stderr lines of a running job show in its snapshot and are replaced by the final tail', () => {
  const record = new JobRecord({ id: 'e1', kind: 'stream', type: 'ffmpeg', class: 'default', owner: 'o', priority: 0, labels: {} });
  record.push({ state: 'running' });
  assert.equal(record.snapshot().stderrTail, null);
  const event = record.push({ stderrTail: 'connection timed out' });
  assert.equal(event.state, 'running');
  assert.equal(event.stderrTail, 'connection timed out');
  assert.equal(record.snapshot().stderrTail, 'connection timed out');
  record.push({ state: 'failed', exitCode: 1, error: { code: 'FFMPEG_EXIT', message: 'x' }, stderrTail: 'final tail' });
  assert.equal(record.snapshot().stderrTail, 'final tail');
});
