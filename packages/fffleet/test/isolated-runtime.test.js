import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTmpfs, runIsolatedCommand } from '../src/isolated-runtime.js';

test('isolated runtime defaults to Podman and rejects unsupported runtimes before touching scratch', async () => {
  await assert.rejects(
    runIsolatedCommand({ runtime: 'nerdctl', image: 'example/image:1', command: 'true', workDir: '/not-used' }),
    /must be podman or docker/,
  );
});

test('isolated runtime requires an explicit image and command', async () => {
  await assert.rejects(
    runIsolatedCommand({ image: '', command: 'true', workDir: '/not-used' }),
    /trusted image is required/,
  );
  await assert.rejects(
    runIsolatedCommand({ image: 'example/image:1', command: '', workDir: '/not-used' }),
    /explicit command is required/,
  );
});

test('isolated runtime rejects malformed args, users and environment values', async () => {
  const base = { image: 'example/image:1', command: 'true', workDir: '/not-used' };
  await assert.rejects(runIsolatedCommand({ ...base, args: [1] }), /array of strings/);
  await assert.rejects(runIsolatedCommand({ ...base, user: 'root' }), /numeric UID:GID/);
  await assert.rejects(runIsolatedCommand({ ...base, env: { BAD: 'line\nbreak' } }), /invalid isolated environment variable/);
  await assert.rejects(runIsolatedCommand({ ...base, env: { AWS_SECRET_ACCESS_KEY: 'should-not-pass' } }), /invalid isolated environment variable/);
});

test('isolated runtime refuses ordinary disk-backed scratch before launching a container', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fffleet-isolated-'));
  try {
    if (await isTmpfs(dir)) {
      t.skip('the platform temporary directory is already tmpfs-backed');
      return;
    }
    await assert.rejects(
      runIsolatedCommand({ image: 'example/image:1', command: 'true', workDir: dir }),
      /workDir is not on tmpfs/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
