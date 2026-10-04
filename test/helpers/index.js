import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

export const WORKER_BIN = join(root, 'packages/fffleet-worker/bin/fffleet-worker.js');
export const ORCHESTRATOR_BIN = join(root, 'packages/fffleet-orchestrator/bin/fffleet-orchestrator.js');

/**
 * Starts a bin script as a child process and waits for its "listening on <url>" line.
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, url: string, logs: string[], stop: (signal?: string) => Promise<void> }>}
 */
export function startBin(bin, env = {}, { timeoutMs = 15000 } = {}) {
  const proc = spawn(process.execPath, [bin], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const exited = new Promise(resolve => proc.once('exit', resolve));
  const stop = async (signal = 'SIGTERM') => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
    await exited;
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop('SIGKILL');
      reject(new Error(`${bin} did not start:\n${logs.join('')}`));
    }, timeoutMs);
    const onData = chunk => {
      const text = chunk.toString();
      logs.push(text);
      if (process.env.FFFLEET_TEST_VERBOSE) process.stderr.write(text);
      const m = text.match(/listening on (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, url: m[1], logs, stop });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`${bin} exited with ${code}:\n${logs.join('')}`));
    });
  });
}

/** Polls `fn` until it returns a truthy value. */
export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${message}${last instanceof Error ? `: ${last.message}` : ''}`);
}

export async function tempDir(prefix = 'fffleet-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Average colour of a media file's first frame (or the frame at `seek` seconds) as [r, g, b]. */
export async function averageColor(file, { seek } = {}) {
  const args = ['-v', 'error', ...(seek !== undefined ? ['-ss', String(seek)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  const { stdout } = await run('ffmpeg', args, { encoding: 'buffer' });
  return [...stdout.subarray(0, 3)];
}

export const isRed = ([r, g, b]) => r > 180 && g < 70 && b < 70;
export const isGreen = ([r, g, b]) => g > 180 && r < 70 && b < 70;
export const isBlue = ([r, g, b]) => b > 180 && r < 70 && g < 70;

/** Segment files listed in an HLS playlist, oldest first. */
export async function hlsSegments(playlist) {
  const text = await readFile(playlist, 'utf8');
  return text.split('\n').filter(l => l && !l.startsWith('#'));
}

/** JSON request helper. */
export async function api(url, { method = 'GET', token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/** ffmpeg arguments for a live test-pattern stream of one colour written as HLS. */
export function colorStreamArgs(color, { size = '320x240' } = {}) {
  return [
    '-re', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=25`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '25',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6', '-hls_flags', 'delete_segments',
    '{{output:hls}}',
  ];
}
