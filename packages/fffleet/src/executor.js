import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { HTTP_SCHEMES, resolvePlaceholders } from './contract.js';
import { FleetError } from './job-record.js';
import { createProgressParser } from './progress.js';
import { parseS3Uri } from './s3.js';

const STDERR_TAIL_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5000;

/**
 * @typedef {object} ExecutorRuntime
 * @property {string} workDir                     Private scratch directory for this job.
 * @property {AbortSignal} signal                 Aborted on cancel or timeout; `signal.reason` is a FleetError.
 * @property {(state: string, extra?: object) => void} setState
 * @property {(progress: object) => void} progress
 * @property {(stdin: import('node:stream').Writable | null) => void} attachStdin
 * @property {(direction: 'in' | 'out', scheme: string, bytes: number) => void} [transfer]   Counts staged and uploaded bytes.
 * @property {string} [ffmpegPath]
 * @property {typeof fetch} [fetch]
 * @property {ReturnType<typeof import('./s3.js').createS3Client> | null} [s3]   Needed for s3: URIs.
 * @property {ReturnType<typeof import('./input-cache.js').createInputCache> | null} [cache]   Reuses staged s3: and http(s): inputs between jobs.
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
  const values = { input: {}, inputdir: {}, output: {} };
  const scheme = e => new URL(e.uri).protocol;

  if (!rt.s3 && [...spec.inputs, ...spec.outputs].some(e => scheme(e) === 's3:')) {
    throw new FleetError('UNSUPPORTED_SCHEME', 'this runner has no S3 credentials for s3: URIs');
  }

  const needsStaging = batch && spec.inputs.some(i => HTTP_SCHEMES.includes(scheme(i)) || scheme(i) === 's3:');
  if (needsStaging) rt.setState('staging');
  for (const input of spec.inputs) {
    const local = await stageInput(input, { batch, rt, doFetch });
    values.input[input.name] = local;
    if (local !== input.uri) values.inputdir[input.name] = dirname(local);
    if (local !== input.uri && scheme(input) !== 'file:') rt.transfer?.('in', scheme(input).slice(0, -1), (await stat(local)).size);
  }

  /** @type {{ name: string, uri: string, local: string | null, upload: false | 'http' | 's3', folder?: boolean, contentType?: string }[]} */
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
      outputs.push({ name: output.name, uri: output.uri, local: path, upload: 'http', contentType: output.contentType });
      values.output[output.name] = path;
    } else if (url.protocol === 's3:') {
      const { key } = parseS3Uri(output.uri);
      const folder = key === '' || key.endsWith('/');
      // A folder output is a directory ffmpeg writes into, e.g. {{output:hls}}/index.m3u8.
      const path = join(rt.workDir, 'out', folder ? output.name : `${output.name}${extname(key)}`);
      await mkdir(folder ? path : dirname(path), { recursive: true });
      outputs.push({ name: output.name, uri: output.uri, local: path, upload: 's3', folder, contentType: output.contentType });
      values.output[output.name] = path;
    } else {
      outputs.push({ name: output.name, uri: output.uri, local: null, upload: false });
      values.output[output.name] = output.uri;
    }
  }

  rt.signal.throwIfAborted();

  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'warning', ...(spec.stdout ? [] : ['-progress', 'pipe:1']),
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
        bytes = o.folder ? ((await readdir(o.local)).length ? 0 : null) : (await stat(o.local)).size;
      } catch {
        bytes = null;
      }
      if (bytes === null && batch) throw new FleetError('OUTPUT_MISSING', `ffmpeg did not write output "${o.name}"`, { details: { exitCode, stderrTail } });
    }
    if (o.upload === 'http') await uploadOutput(o, { rt, doFetch });
    if (o.upload === 's3') bytes = await uploadS3Output(o, rt);
    if (o.upload) rt.transfer?.('out', scheme(o).slice(0, -1), bytes ?? 0);
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
  if (batch && url.protocol === 's3:') {
    const { bucket, key } = parseS3Uri(input.uri);
    // Each input gets its own directory, so {{inputdir:name}} holds only that file (for example a font for ass fontsdir).
    const path = join(rt.workDir, 'in', input.name, `file${extname(key)}`);
    await mkdir(dirname(path), { recursive: true });
    try {
      const head = rt.cache ? await rt.s3.head(bucket, key, { signal: rt.signal }).catch(() => null) : null;
      if (head?.etag) {
        await rt.cache.stage({ key: input.uri, validator: head.etag, target: path, download: p => rt.s3.getFile(bucket, key, p, { signal: rt.signal }) });
      } else {
        await rt.s3.getFile(bucket, key, path, { signal: rt.signal });
      }
    } catch (err) {
      if (rt.signal.aborted) throw rt.signal.reason;
      throw new FleetError('INPUT_FAILED', `could not fetch input "${input.name}": ${err.message}`);
    }
    return path;
  }
  if (!batch || !HTTP_SCHEMES.includes(url.protocol)) return input.uri;

  const path = join(rt.workDir, 'in', input.name, `file${extname(url.pathname)}`);
  await mkdir(dirname(path), { recursive: true });
  if (rt.cache) {
    const head = await doFetch(input.uri, { method: 'HEAD', signal: rt.signal }).catch(() => null);
    const validator = head?.ok ? head.headers.get('etag') ?? (head.headers.get('last-modified') && head.headers.get('content-length') ? `${head.headers.get('last-modified')}|${head.headers.get('content-length')}` : null) : null;
    if (validator) {
      try {
        await rt.cache.stage({ key: input.uri, validator, target: path, download: p => downloadHttp(input, p, { rt, doFetch }) });
      } catch (err) {
        if (err instanceof FleetError) throw err;
        if (rt.signal.aborted) throw rt.signal.reason;
        throw new FleetError('INPUT_FAILED', `could not fetch input "${input.name}": ${err.message}`);
      }
      return path;
    }
  }
  await downloadHttp(input, path, { rt, doFetch });
  return path;
}

async function downloadHttp(input, path, { rt, doFetch }) {
  let res;
  try {
    res = await doFetch(input.uri, { signal: rt.signal });
  } catch (err) {
    if (rt.signal.aborted) throw rt.signal.reason;
    throw new FleetError('INPUT_FAILED', `could not fetch input "${input.name}": ${err.message}`);
  }
  if (!res.ok || !res.body) throw new FleetError('INPUT_FAILED', `could not fetch input "${input.name}": HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
}

async function uploadS3Output(o, rt) {
  const { bucket, key } = parseS3Uri(o.uri);
  try {
    return o.folder
      ? await rt.s3.putDirectory(bucket, key, o.local, { signal: rt.signal })
      : await rt.s3.putFile(bucket, key, o.local, { contentType: o.contentType, signal: rt.signal });
  } catch (err) {
    if (rt.signal.aborted) throw rt.signal.reason;
    throw new FleetError('UPLOAD_FAILED', `upload of output "${o.name}" failed: ${err.message}`);
  }
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

    if (spec.stdout) {
      rt.attachStdout?.(child.stdout);
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', parse);
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => {
      tail = (tail + d).slice(-STDERR_TAIL_BYTES);
      rt.stderr?.(tail.trim());
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
