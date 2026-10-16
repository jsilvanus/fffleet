import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runIsolatedCommand, isTmpfs } from '../src/isolated-runtime.js';

test('Podman isolated runtime transfers regular files without host mounts', { timeout: 120000, skip: process.env.FFFLEET_TEST_PODMAN !== '1' }, async () => {
  const workDir = await mkdtemp('/dev/shm/fffleet-isolated-integration-');
  try {
    assert.equal(await isTmpfs(workDir), true, '/dev/shm must be tmpfs for this test');
    await mkdir(join(workDir, 'in'), { recursive: true });
    await writeFile(join(workDir, 'in', 'input.txt'), 'isolated-runtime-ok\n');

    const result = await runIsolatedCommand({
      runtime: 'podman',
      image: 'docker.io/library/alpine:3.22',
      command: '/bin/sh',
      args: ['-c', 'cat /work/in/input.txt > /work/out/result.txt; ln -s /etc/passwd /work/out/host-file-link'],
      workDir,
      limits: { memory: '256m', cpus: 1, pids: 64, workSize: '64m', tmpSize: '16m' },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.outputs, ['result.txt'], 'symlinks must not be exported');
    assert.equal(await readFile(join(workDir, 'out', 'result.txt'), 'utf8'), 'isolated-runtime-ok\n');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
