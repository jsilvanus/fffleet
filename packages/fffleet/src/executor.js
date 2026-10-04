import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { HTTP_SCHEMES, resolvePlaceholders } from './contract.js';
import { FleetError } from './job-record.js';
import { createProgressParser } from './progress.js';

const STDERR_TAIL_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5000;

/**
 * @typedef {object} ExecutorRuntime
 * @property {string} workDir                     Private scratch directory for this job.
 * @property {AbortSignal} signal                 Aborted on cancel or timeout; `signal.reason` is a FleetError.
 * @property {(state: string, extra?: object) => void} setState
 * @property {(progress: object) => void} progress
 * @property {(stdin: import('node:stream').Writable | null) => void} attachStdin
 * @property {string} [ffmpegPath]
 * @property {typeof fetch} [fetch]
 */

/**
 * Runs one ffmpeg job: stages inputs, resolves placeholders, runs ffmpeg with progress reporting,
 * then uploads outputs. Resolves with the final result or throws a FleetError.
 *
 * @param {import('./types.js').JobSpec & { id: string }} spec
 * @param {ExecutorRuntime} rt
 * @returns {Promise<{ exitCode: number, outputs: import('./types.js').OutputResult[], stderrTail: string | null }>}
 */
export async function runFfmpegJob(spec, rt) {
  const doFetch = rt.fetch ?? globalThis.fetch;
  const batch = spec.kind === 'batch';
  const values = { input: {}, output: {} };

  const needsStaging = batch && spec.inputs.some(i => HTTP_SCHEMES.includes(new URL(i.uri).protocol));
  if (needsStaging) rt.setState('staging');
  for (const input of spec.inputs) {
    values.input[input.name] = await stageInput(input, { batch, rt, doFetch });
  }

  /** @type {{ name: string, uri: string, local: string | null, upload: boolean, contentType?: string }[]} */
  const outputs = [];
  for (const output of spec.outputs) {
    const url = new URL(output.uri);
    if (url.protocol === 'file:') {
      const path = fileURLToPath(url);
      await mkdir(dirname(path), { recursive: true });
      outputs.push({ name: output.name, uri: output.uri, local: path, upload: false });
      values.output[output.name] = path;
    } else if (batch && HTTP_SCHEMES.includes(url.protocol)) {
      const path = join(rt.workDir, 'out', `${output.name}${extname(url.pathname)}`);
      await mkdir(dirname(path), { recursive: true });
      outputs.push({ name: output.name, uri: output.uri, local: path, upload: true, contentType: output.contentType });
      values.output[output.name] = path;
    } else {
      outputs.push({ name: output.name, uri: output.uri, local: null, upload: false });
      values.output[output.name] = output.uri;
    }
  }

  rt.signal.throwIfAborted();

  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'warning', '-progress', 'pipe:1',
    ...(spec.stdin ? [] : ['-nostdin']),
    ...(batch ? ['-y'] : []),
    ...resolvePlaceholders(spec.ffmpeg.args, values),
  ];
  const { exitCode, stderrTail } = await runProcess(rt.ffmpegPath ?? 'ffmpeg', args, spec, rt);

  rt.signal.throwIfAborted();
  if (exitCode !== 0) {
    throw new FleetError('FFMPEG_EXIT', `ffmpeg exited with code ${exitCode}`, { details: { exitCode, stderrTail } });
  }

  const results = [];
  if (outputs.some(o => o.upload)) rt.setState('uploading');
  for (const o of outputs) {
    let bytes = null;
    if (o.local) {
      try {
        bytes = (await stat(o.local)).size;
      } catch {
        if (batch) throw new FleetError('OUTPUT_MISSING', `ffmpeg did not write output "${o.name}"`, { details: { exitCode, stderrTail } });
      }
    }
    if (o.upload) await uploadOutput(o, { rt, doFetch });
    results.push({ name: o.name, uri: o.uri, bytes });
  }
  return { exitCode, outputs: results, stderrTail };
}

async function stageInput(input, { batch, rt, doFetch }) {
  const url = new URL(input.uri);
  if (url.protocol === 'file:') {
    const path = fileURLToPath(url);
    if (batch) {
      try {
        await stat(path);
      } catch {
        throw new FleetError('INPUT_FAILED', `input "${input.name}" not found at ${path}`);
      }
    }
    return path;
  }
  if (!batch || !HTTP_SCHEMES.includes(url.protocol)) return input.uri;

  const path = join(rt.workDir, 'in', `${input.name}${extname(url.pathname)}`);
  await mkdir(dirname(path), { recursive: true });
  let res;
  try {
    res = await doFetch(input.uri, { signal: rt.signal });
  } catch (err) {
    if (rt.signal.aborted) throw rt.signal.reason;
    throw new FleetError('INPUT_FAILED', `could not fetch input "${input.name}": ${err.message}`);
  }
  if (!res.ok || !res.body) throw new FleetError('INPUT_FAILED', `could not fetch input "${input.name}": HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  return path;
}

async function uploadOutput(o, { rt, doFetch }) {
  const size = (await stat(o.local)).size;
  const fh = await open(o.local, 'r');
  try {
    const res = await doFetch(o.uri, {
      method: 'PUT',
      headers: { 'content-type': o.contentType ?? 'application/octet-stream', 'content-length': String(size) },
      body: Readable.toWeb(fh.createReadStream()),
      duplex: 'half',
      signal: rt.signal,
    });
    if (!res.ok) throw new FleetError('UPLOAD_FAILED', `upload of output "${o.name}" failed: HTTP ${res.status}`);
  } catch (err) {
    if (err instanceof FleetError) throw err;
    if (rt.signal.aborted) throw rt.signal.reason;
    throw new FleetError('UPLOAD_FAILED', `upload of output "${o.name}" failed: ${err.message}`);
  } finally {
    await fh.close().catch(() => {});
  }
}

function runProcess(cmd, args, spec, rt) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: [spec.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new FleetError('SPAWN_FAILED', `could not start ${cmd}: ${err.message}`));
      return;
    }
    let tail = '';
    let killTimer = null;
    let started = false;
    const parse = createProgressParser(p => {
      const { end, ...progress } = p;
      rt.progress(progress);
    }, { durationMs: spec.ffmpeg.durationMs });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', parse);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => {
      tail = (tail + d).slice(-STDERR_TAIL_BYTES);
    });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      rt.attachStdin(child.stdin);
    }

    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    rt.signal.addEventListener('abort', onAbort, { once: true });

    child.once('spawn', () => {
      started = true;
      rt.setState('running', { pid: child.pid });
    });
    child.once('error', err => {
      if (!started) {
        rt.signal.removeEventListener('abort', onAbort);
        reject(new FleetError('SPAWN_FAILED', `could not start ${cmd}: ${err.message}`));
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(killTimer);
      rt.signal.removeEventListener('abort', onAbort);
      rt.attachStdin(null);
      if (!started) return;
      resolve({ exitCode: code ?? (signal ? 128 : 1), stderrTail: tail.trim() || null });
    });
  });
}
