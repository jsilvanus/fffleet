import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const TMPFS_MAGIC = 0x01021994;
const STDERR_LIMIT = 8192;
const SAFE_ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_USER = /^\d+:\d+$/;
const SENSITIVE_ENV = /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|API[_-]?KEY)/i;

/**
 * Run a command in a fresh, network-isolated OCI container without host bind mounts.
 *
 * The host-side workDir MUST be on tmpfs. Inputs are copied into the container over a tar stream;
 * outputs are copied back over a tar stream. No host directory is mounted in the container.
 * The image must contain /bin/sh, sleep, find and tar. The image and command must be trusted by the
 * caller; this function is a runtime boundary, not an authorization or image-signing system.
 *
 * @param {object} opts
 * @param {'podman'|'docker'} [opts.runtime='podman'] Podman is preferred; Docker is optional.
 * @param {string} opts.image Trusted image reference.
 * @param {string} opts.command Executable available inside the image.
 * @param {string[]} [opts.args]
 * @param {Record<string,string>} [opts.env] Explicit environment only; host environment is never inherited.
 * @param {string} opts.workDir Job scratch directory, required to be on tmpfs by default.
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.user='1000:1000'] Container UID:GID.
 * @param {{memory?:string,cpus?:number,pids?:number,workSize?:string,tmpSize?:string}} [opts.limits]
 * @param {(line:string)=>void} [opts.onOutput]
 * @param {boolean} [opts.requireTmpfs=true] Disable only for controlled tests; production must leave enabled.
 * @returns {Promise<{exitCode:number,stderrTail:string|null,outputs:string[]}>}
 */
export async function runIsolatedCommand({
  runtime = 'podman',
  image,
  command,
  args = [],
  env = {},
  workDir,
  signal,
  user = '1000:1000',
  limits = {},
  onOutput = () => {},
  requireTmpfs = true,
}) {
  if (!['podman', 'docker'].includes(runtime)) throw new Error('isolated runtime must be podman or docker');
  if (typeof image !== 'string' || !image.trim()) throw new Error('an explicit trusted image is required');
  if (typeof command !== 'string' || !command.trim()) throw new Error('an explicit command is required');
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('args must be an array of strings');
  const [uid, gid] = typeof user === 'string' ? user.split(':').map(Number) : [];
  if (!SAFE_USER.test(user) || !Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 0) {
    throw new Error('user must be a non-root numeric UID:GID pair');
  }
  for (const [key, value] of Object.entries(env)) {
    if (!SAFE_ENV.test(key) || SENSITIVE_ENV.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value)) {
      throw new Error(`invalid isolated environment variable ${key}`);
    }
  }

  if (typeof workDir !== 'string' || !workDir.trim()) throw new Error('an absolute workDir is required');
  const root = resolve(workDir);
  if (!isAbsolute(root)) throw new Error('an absolute workDir is required');
  await mkdir(root, { recursive: true });
  if (requireTmpfs && !(await isTmpfs(root))) {
    throw new Error('isolated execution refused: workDir is not on tmpfs; set FFFLEET_WORK_DIR to a memory-backed filesystem');
  }
  if (!(await isSwapDisabled())) {
    throw new Error('isolated execution refused: host swap is enabled or could not be verified disabled; tmpfs data could otherwise be paged to disk');
  }
  if (runtime === 'docker') await assertLocalDocker();
  signal?.throwIfAborted();

  const inputDir = await checkedChildDir(root, 'in');
  const outputDir = await checkedChildDir(root, 'out');
  const name = `fffleet-job-${randomBytes(8).toString('hex')}`;
  const memory = limits.memory ?? '1g';
  const cpus = Number(limits.cpus ?? 2);
  const pids = Number(limits.pids ?? 128);
  const workSize = limits.workSize ?? '1g';
  const tmpSize = limits.tmpSize ?? '256m';
  const memoryBytes = sizeBytes(memory, 'memory', 64 * 1024 ** 3);
  const workBytes = sizeBytes(workSize, 'workSize', 64 * 1024 ** 3);
  sizeBytes(tmpSize, 'tmpSize', 16 * 1024 ** 3);
  if (workBytes > memoryBytes) throw new Error('workSize cannot exceed the container memory limit');
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64 || !Number.isInteger(pids) || pids < 1 || pids > 8192) {
    throw new Error('invalid isolated execution resource limits (cpus must be <=64; pids must be <=8192)');
  }

  const createArgs = [
    'run', '--detach', '--name', name,
    '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    `--pids-limit=${pids}`, `--memory=${memory}`, `--memory-swap=${memory}`, `--cpus=${cpus}`,
    `--user=${user}`,
    `--tmpfs=/work:rw,nosuid,nodev,size=${workSize},mode=0777`,
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${tmpSize},mode=1777`,
    '--entrypoint=/bin/sh', image, '-c', 'while :; do sleep 3600; done',
  ];

  let createAttempted = false;
  let stderrTail = '';
  const output = line => {
    if (!line) return;
    stderrTail = (stderrTail + line + '\n').slice(-STDERR_LIMIT);
    onOutput(line);
  };
  try {
    signal?.throwIfAborted();
    createAttempted = true;
    await runTool(runtime, createArgs, { signal });
    await runTool(runtime, ['exec', name, 'mkdir', '-p', '/work/in', '/work/out'], { signal, onStdout: output, onStderr: output });

    await transferIntoContainer(runtime, name, inputDir, signal, output, workBytes);
    signal?.throwIfAborted();

    const execArgs = ['exec', '--workdir=/work', `--user=${user}`];
    const isolatedEnv = { ...env, HOME: '/tmp', TMPDIR: '/tmp', XDG_CACHE_HOME: '/tmp/.cache', FFFLEET_INPUT_DIR: '/work/in', FFFLEET_OUTPUT_DIR: '/work/out' };
    for (const [key, value] of Object.entries(isolatedEnv)) execArgs.push('--env', `${key}=${value}`);
    execArgs.push(name, command, ...args);
    const exitCode = await runTool(runtime, execArgs, {
      signal,
      allowNonZero: true,
      onStdout: output,
      onStderr: output,
    });

    signal?.throwIfAborted();
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    await transferOutOfContainer(runtime, name, outputDir, signal, output);
    const outputs = await listRelativeFiles(outputDir);
    return { exitCode, stderrTail: stderrTail.trim() || null, outputs };
  } finally {
    if (createAttempted) await runTool(runtime, ['rm', '--force', name], { allowNonZero: true }).catch(() => {});
  }
}

/** True only when /proc/swaps confirms no active swap devices/files; unsupported systems fail closed. */
async function isSwapDisabled() {
  try {
    const lines = (await readFile('/proc/swaps', 'utf8')).trim().split('\\n');
    return lines.length <= 1;
  } catch {
    return false;
  }
}

async function assertLocalDocker() {
  const configured = process.env.DOCKER_HOST;
  if (configured) {
    if (!isLocalDockerEndpoint(configured)) throw new Error('isolated execution refused: remote Docker endpoints are not supported; use local rootless Podman or a local Docker daemon');
    return;
  }
  const contextResult = await captureTool('docker', ['context', 'show']);
  const context = contextResult.stdout.toString('utf8').trim();
  if (!context) throw new Error('isolated execution refused: could not identify the Docker context');
  const inspected = await captureTool('docker', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']);
  let endpoint;
  try {
    endpoint = JSON.parse(inspected.stdout.toString('utf8').trim());
  } catch {
    throw new Error('isolated execution refused: could not verify that the Docker context is local');
  }
  if (typeof endpoint !== 'string' || !isLocalDockerEndpoint(endpoint)) {
    throw new Error('isolated execution refused: remote Docker contexts are not supported; use local rootless Podman or a local Docker daemon');
  }
}

function isLocalDockerEndpoint(endpoint) {
  return /^(?:unix:\/\/|npipe:\/\/)/i.test(endpoint);
}

function sizeBytes(value, name, maxBytes) {
  const match = String(value).match(/^(\d+)([kmg])?$/i);
  if (!match) throw new Error(`${name} must be a numeric size such as 512m or 2g`);
  const multiplier = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(match[2] ?? '').toLowerCase()] ?? 1;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes) {
    throw new Error(`${name} is outside the allowed size range`);
  }
  return bytes;
}

/** Linux tmpfs check; unknown/unsupported filesystems fail closed. */
export async function isTmpfs(path) {
  try {
    const info = await statfs(path);
    return Number(info.type) === TMPFS_MAGIC;
  } catch {
    return false;
  }
}

function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function checkedChildDir(root, name) {
  const path = resolve(root, name);
  if (!within(root, path)) throw new Error('scratch path escaped workDir');
  await mkdir(path, { recursive: true });
  const realRoot = await realpath(root);
  const realPath = await realpath(path);
  if (!within(realRoot, realPath)) throw new Error('scratch directory resolves outside workDir');
  return realPath;
}

async function listRelativeFiles(root) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) files.push(rel);
      // Symlinks and special files are intentionally not returned.
    }
  }
  await walk(root);
  return files.sort();
}

function runTool(command, args, { signal, allowNonZero = false, onStdout = () => {}, onStderr = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const actualArgs = command === 'podman' ? ['--remote=false', ...args] : args;
    const child = spawn(command, actualArgs, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stderrTail = '';
    child.stdout.on('data', chunk => onStdout(chunk.toString().trimEnd()));
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-STDERR_LIMIT);
      onStderr(text.trimEnd());
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 || (allowNonZero && code !== null)) resolve(code ?? 1);
      else reject(new Error(`${command} ${args[0]} failed with exit code ${code}: ${stderrTail.trim()}`));
    });
  });
}

async function regularFiles(root) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const info = await lstat(full);
        if (info.isFile() && !info.isSymbolicLink()) files.push({ full, relative: rel, size: info.size });
      }
      // Symlinks and special files are intentionally not transferred.
    }
  }
  await walk(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function transferIntoContainer(runtime, name, inputDir, signal, onOutput, maxBytes) {
  const files = await regularFiles(inputDir);
  const total = files.reduce((n, file) => n + file.size, 0);
  if (total > maxBytes) throw new Error('input transfer exceeds the configured isolated workSize limit');
  const dirs = new Set(['/work/in']);
  for (const file of files) {
    const parent = file.relative.split('/').slice(0, -1);
    let current = '/work/in';
    for (const part of parent) {
      if (!part || part === '.' || part === '..') throw new Error('unsafe input path');
      current += `/${part}`;
      dirs.add(current);
    }
  }
  for (const dir of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    signal?.throwIfAborted();
    await runTool(runtime, ['exec', name, 'mkdir', '-p', dir], { signal, onStdout: onOutput, onStderr: onOutput });
  }
  for (const file of files) {
    signal?.throwIfAborted();
    await runTool(runtime, ['cp', file.full, `${name}:/work/in/${file.relative}`], { signal, onStdout: onOutput, onStderr: onOutput });
  }
}

async function transferOutOfContainer(runtime, name, outputDir, signal, onOutput) {
  const listed = await captureTool(runtime, ['exec', name, 'find', '/work/out', '-type', 'f', '-print0'], { signal, maxBytes: 8 * 1024 * 1024 });
  const paths = listed.stdout.toString('utf8').split(String.fromCharCode(0)).filter(Boolean);
  for (const source of paths) {
    signal?.throwIfAborted();
    const prefix = '/work/out/';
    if (!source.startsWith(prefix)) throw new Error('runtime returned an output path outside /work/out');
    const rel = source.slice(prefix.length);
    const parts = rel.split('/');
    if (!rel || parts.some(part => !part || part === '.' || part === '..')) throw new Error('runtime returned an unsafe output path');
    const destination = resolve(outputDir, ...parts);
    if (!within(outputDir, destination)) throw new Error('output path escaped workDir');
    await mkdir(resolve(destination, '..'), { recursive: true });
    const temporary = `${destination}.fffleet-${randomBytes(4).toString('hex')}.part`;
    try {
      await runTool(runtime, ['cp', `${name}:${source}`, temporary], { signal, onStdout: onOutput, onStderr: onOutput });
      const info = await lstat(temporary);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function captureTool(command, args, { signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const actualArgs = command === 'podman' ? ['--remote=false', ...args] : args;
    const child = spawn(command, actualArgs, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill();
        reject(new Error(`${command} output exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT); });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve({ stdout: Buffer.concat(chunks), stderr })
      : reject(new Error(`${command} ${args[0]} failed with exit code ${code}: ${stderr.trim()}`)));
  });
}

function waitOutcome(child) {
  return new Promise(resolve => {
    let error = null;
    child.once('error', err => { error = err; });
    child.once('close', code => resolve({ code: code ?? 1, error }));
  });
}
