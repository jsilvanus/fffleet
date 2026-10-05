// An ffmpeg that ignores SIGTERM is stopped with SIGKILL after the grace period, so a timed-out or cancelled job always ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobManager } from '../src/index.js';
import { collect, tempDir } from './helpers.js';

// The stuck ffmpeg is a shell script that traps SIGTERM; Windows has no such script, and kills the whole tree there anyway.
const skip = process.platform === 'win32' && 'needs a POSIX shell script as ffmpeg';

async function stuckManager(tmp) {
  const fake = join(tmp.dir, 'stuck-ffmpeg.sh');
  writeFileSync(fake, '#!/bin/sh\ntrap \'\' TERM\necho started >&2\nwhile :; do sleep 0.2; done\n');
  chmodSync(fake, 0o755);
  return new JobManager({ workRoot: join(tmp.dir, 'work'), ffmpegPath: fake });
}

const spec = (id, extra = {}) => ({ id, kind: 'stream', ffmpeg: { args: ['-i', 'x', '-f', 'null', '-'] }, ...extra });

test('a job that times out is killed even when ffmpeg ignores SIGTERM', { skip, timeout: 30000 }, async () => {
  const tmp = await tempDir();
  const manager = await stuckManager(tmp);
  const t0 = Date.now();
  manager.submit(spec('stuck-timeout', { timeoutMs: 500 }));
  const final = (await collect(manager, 'stuck-timeout').done).at(-1);
  const took = Date.now() - t0;
  assert.equal(final.state, 'failed');
  assert.equal(final.error.code, 'TIMEOUT');
  // SIGTERM is ignored, so the end comes from the SIGKILL after the grace period (5 s), not from the timeout itself.
  assert.ok(took >= 4000, `ended after ${took} ms, before the SIGKILL grace period`);
  assert.ok(took < 15000, `ended after ${took} ms`);
  await manager.close();
  await tmp.cleanup();
});

test('a cancelled job is killed even when ffmpeg ignores SIGTERM', { skip, timeout: 30000 }, async () => {
  const tmp = await tempDir();
  const manager = await stuckManager(tmp);
  manager.submit(spec('stuck-cancel'));
  const { done } = collect(manager, 'stuck-cancel');
  // Cancel once ffmpeg is really running.
  await new Promise(resolve => {
    const poll = setInterval(() => manager.get('stuck-cancel')?.state === 'running' && (clearInterval(poll), resolve()), 20);
  });
  await new Promise(r => setTimeout(r, 200));
  manager.cancel('stuck-cancel');
  const final = (await done).at(-1);
  assert.equal(final.state, 'cancelled');
  await manager.close();
  await tmp.cleanup();
});
