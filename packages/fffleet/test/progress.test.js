import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressParser } from '../src/index.js';

const block = (us, progress = 'continue') => `frame=50\nfps=25.0\nout_time_us=${us}\nout_time_ms=${us}\nspeed=1.5x\nprogress=${progress}\n`;

test('parses blocks, including ones split across chunks', () => {
  const seen = [];
  const feed = createProgressParser(p => seen.push(p), { durationMs: 4000 });
  const text = block(1000000) + block(2000000, 'end');
  feed(text.slice(0, 17));
  feed(text.slice(17, 60));
  feed(text.slice(60));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { pct: 25, outTimeMs: 1000, speed: 1.5, fps: 25, frame: 50, end: false });
  assert.equal(seen[1].pct, 50);
  assert.equal(seen[1].end, true);
});

test('without a duration pct is null; N/A values are null', () => {
  const seen = [];
  createProgressParser(p => seen.push(p))('out_time_us=N/A\nspeed=N/A\nprogress=continue\n');
  assert.deepEqual(seen[0], { pct: null, outTimeMs: null, speed: null, fps: null, frame: null, end: false });
});

test('pct never exceeds 100', () => {
  const seen = [];
  createProgressParser(p => seen.push(p), { durationMs: 1000 })(block(5000000));
  assert.equal(seen[0].pct, 100);
});
