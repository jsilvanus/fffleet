import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

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
  if (!SAFE_USER.test(user)) throw new Error('user must be a numeric UID:GID pair');
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
  signal?.throwIfAborted();

  const inputDir = await checkedChildDir(root, 'in');
  const outputDir = await checkedChildDir(root, 'out');
  const name = `fffleet-job-${randomBytes(8).toString('hex')}`;
  const memory = limits.memory ?? '1g';
  const cpus = Number(limits.cpus ?? 2);
  const pids = Number(limits.pids ?? 128);
  const workSize = limits.workSize ?? '1g';
  const tmpSize = limits.tmpSize ?? '256m';
  if (!/^\d+(?:[kmg])?$/i.test(memory) || !/^\d+(?:[kmg])?$/i.test(workSize) || !/^\d+(?:[kmg])?$/i.test(tmpSize)) {
    throw new Error('memory, workSize and tmpSize must be numeric sizes such as 512m or 2g');
  }
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 256 || !Number.isInteger(pids) || pids < 1 || pids > 65536) {
    throw new Error('invalid isolated execution resource limits');
  }

  const createArgs = [
    'run', '--detach', '--name', name,
    '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    `--pids-limit=${pids}`, `--memory=${memory}`, `--memory-swap=${memory}`, `--cpus=${cpus}`,
    `--user=${user}`,
    `--tmpfs=/work:rw,nosuid,nodev,size=${workSize},uid=${user.split(':')[0]},gid=${user.split(':')[1]}`,
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${tmpSize},uid=${user.split(':')[0]},gid=${user.split(':')[1]}`,
    '--entrypoint=/bin/sh', image, '-c', 'while :; do sleep 3600; done',
  ];

  let created = false;
  let stderrTail = '';
  const output = line => {
    if (!line) return;
    stderrTail = (stderrTail + line + '\n').slice(-STDERR_LIMIT);
    onOutput(line);
  };
  try {
    signal?.throwIfAborted();
    await runTool(runtime, createArgs, { signal });
    created = true;
    await runTool(runtime, ['exec', name, 'mkdir', '-p', '/work/in', '/work/out'], { signal, onStdout: output, onStderr: output });

    await transferIntoContainer(runtime, name, inputDir, signal, output);
    signal?.throwIfAborted();

    const execArgs = ['exec', '--workdir=/work', `--user=${user}`];
    for (const [key, value] of Object.entries(env)) execArgs.push('--env', `${key}=${value}`);
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
    if (created) await runTool(runtime, ['rm', '--force', name], { allowNonZero: true }).catch(() => {});
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
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    child.stdout.on('data', chunk => onStdout(chunk.toString().trimEnd()));
    child.stderr.on('data', chunk => onStderr(chunk.toString().trimEnd()));
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 || (allowNonZero && code !== null)) resolve(code ?? 1);
      else reject(new Error(`${command} ${args[0]} failed with exit code ${code}`));
    });
  });
}

async function transferIntoContainer(runtime, name, inputDir, signal, onOutput) {
  // Only regular files are included: symlinks are never archived or followed.
  const find = spawn('find', ['.', '-type', 'f', '-print0'], { cwd: inputDir, stdio: ['ignore', 'pipe', 'pipe'], signal });
  const pack = spawn('tar', ['--null', '-T', '-', '-cf', '-'], { cwd: inputDir, stdio: ['pipe', 'pipe', 'pipe'], signal });
  const unpack = spawn(runtime, ['exec', '-i', name, 'tar', '-xf', '-', '-C', '/work/in'], { stdio: ['pipe', 'ignore', 'pipe'], signal });
  const errors = [];
  for (const child of [find, pack, unpack]) {
    child.stderr.on('data', chunk => { errors.push(chunk.toString()); onOutput(chunk.toString().trimEnd()); });
  }
  const statuses = [wait(find), wait(pack), wait(unpack)];
  try {
    await Promise.all([pipeline(find.stdout, pack.stdin), pipeline(pack.stdout, unpack.stdin)]);
    const codes = await Promise.all(statuses);
    if (codes.some(code => code !== 0)) throw new Error(`input transfer failed: ${errors.join('').slice(-1000)}`);
  } catch (err) {
    for (const child of [find, pack, unpack]) child.kill();
    throw err;
  }
}

async function transferOutOfContainer(runtime, name, outputDir, signal, onOutput) {
  const exportScript = 'cd /work/out && find . -type f -print0 > /tmp/fffleet-files && tar --null -T /tmp/fffleet-files -cf -';
  const pack = spawn(runtime, ['exec', name, '/bin/sh', '-c', exportScript], { stdio: ['ignore', 'pipe', 'pipe'], signal });
  const unpack = spawn('tar', ['--no-same-owner', '--no-same-permissions', '-xf', '-', '-C', outputDir], { stdio: ['pipe', 'ignore', 'pipe'], signal });
  const errors = [];
  for (const child of [pack, unpack]) child.stderr.on('data', chunk => { errors.push(chunk.toString()); onOutput(chunk.toString().trimEnd()); });
  const statuses = [wait(pack), wait(unpack)];
  try {
    await pipeline(pack.stdout, unpack.stdin);
    const codes = await Promise.all(statuses);
    if (codes.some(code => code !== 0)) throw new Error(`output transfer failed: ${errors.join('').slice(-1000)}`);
  } catch (err) {
    for (const child of [pack, unpack]) child.kill();
    throw err;
  }
}

function wait(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}
