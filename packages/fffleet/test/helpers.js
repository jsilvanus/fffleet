import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'fffleet-unit-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Collects a job's events until it is final. */
export function collect(manager, id) {
  const events = [];
  const done = new Promise(resolve => {
    manager.subscribe(id, 0, e => {
      events.push(e);
      if (['succeeded', 'failed', 'cancelled'].includes(e.state)) resolve(events);
    });
  });
  return { events, done };
}

/**
 * Executor for tests: runs until released, cancelled or told to fail.
 * `controls.get(id)` gives { release(result), fail(err) } once the job started.
 */
export function fakeExecutor() {
  const controls = new Map();
  const started = [];
  const executor = (spec, rt) =>
    new Promise((resolve, reject) => {
      started.push(spec.id);
      if (rt.signal.aborted) return reject(rt.signal.reason);
      rt.setState('running');
      rt.signal.addEventListener('abort', () => reject(rt.signal.reason), { once: true });
      controls.set(spec.id, { release: (result = { exitCode: 0, outputs: [] }) => resolve(result), fail: reject, rt });
    });
  return { executor, controls, started };
}

export const fakeSpec = (id, extra = {}) => ({ id, kind: 'batch', type: 'fake', ...extra });

export async function averageColor(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  return [...stdout.subarray(0, 3)];
}

export const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

/** True when every channel is within `tol` of the expected colour. */
export const near = (actual, expected, tol = 8) => actual.every((v, i) => Math.abs(v - expected[i]) <= tol);

/** Polls until `cond()` is truthy (fails the test after `timeoutMs`). */
export async function until(cond, { timeoutMs = 5000, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await tick(5);
  }
}
