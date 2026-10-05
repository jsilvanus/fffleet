import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTTP_SCHEMES } from './contract.js';
import { FleetError } from './job-record.js';
import { parseS3Uri } from './s3.js';

const SHOW = ['format', 'streams', 'chapters', 'programs'];
const MAX_RESULT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Runs ffprobe on the job's single input and returns its JSON in the result.
 *
 * Spec: `type: 'ffprobe'`, `kind: 'batch'`, one input (file:, http(s): or s3:), no outputs, and an
 * optional `ffprobe: { show?: ('format' | 'streams' | 'chapters' | 'programs')[] }` (default
 * `['format', 'streams']`). http(s): inputs are read by ffprobe directly (it fetches only what it
 * needs); s3: inputs are staged to the scratch directory first.
 *
 * Result: one output `{ name: 'probe', uri: 'inline:', bytes, data }` where `data` is ffprobe's JSON.
 *
 * @param {import('./types.js').JobSpec & { id: string, ffprobe?: { show?: string[] } }} spec
 * @param {import('./executor.js').ExecutorRuntime & { ffprobePath?: string }} rt
 */
export async function runFfprobeJob(spec, rt) {
  if (spec.inputs.length !== 1) throw new FleetError('INVALID_SPEC', 'an ffprobe job takes exactly one input', { status: 422 });
  if (spec.outputs.length) throw new FleetError('INVALID_SPEC', 'an ffprobe job takes no outputs; the result is returned inline', { status: 422 });
  const show = spec.ffprobe?.show ?? ['format', 'streams'];
  if (!Array.isArray(show) || !show.length || show.some(s => !SHOW.includes(s))) {
    throw new FleetError('INVALID_SPEC', `ffprobe.show must list some of ${SHOW.join(', ')}`, { status: 422 });
  }

  const input = spec.inputs[0];
  const url = new URL(input.uri);
  let target = input.uri;
  if (url.protocol === 'file:') {
    target = fileURLToPath(url);
  } else if (url.protocol === 's3:') {
    if (!rt.s3) throw new FleetError('UNSUPPORTED_SCHEME', 'this runner has no S3 credentials for s3: URIs');
    const { bucket, key } = parseS3Uri(input.uri);
    target = join(rt.workDir, 'in', input.name, `file${extname(key)}`);
    await mkdir(dirname(target), { recursive: true });
    rt.setState('staging');
    try {
      await rt.s3.getFile(bucket, key, target, { signal: rt.signal });
    } catch (err) {
      if (rt.signal.aborted) throw rt.signal.reason;
      throw new FleetError('INPUT_FAILED', `could not fetch input "${input.name}": ${err.message}`);
    }
  } else if (!HTTP_SCHEMES.includes(url.protocol)) {
    throw new FleetError('UNSUPPORTED_SCHEME', `ffprobe cannot read ${url.protocol} inputs`);
  }

  const args = ['-v', 'error', '-print_format', 'json', ...show.map(s => `-show_${s}`), target];
  rt.setState('running');
  const stdout = await runFfprobe(rt.ffprobePath ?? siblingProbe(rt.ffmpegPath), args, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, rt);

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new FleetError('FFPROBE_OUTPUT', 'ffprobe printed output that is not JSON');
  }
  return { exitCode: 0, outputs: [{ name: 'probe', uri: 'inline:', bytes: Buffer.byteLength(stdout), data }], stderrTail: null };
}

/** `/opt/ffmpeg/bin/ffmpeg` -> `/opt/ffmpeg/bin/ffprobe`; plain `ffmpeg` -> `ffprobe`. */
export function siblingProbe(ffmpegPath) {
  if (!ffmpegPath) return 'ffprobe';
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

function runFfprobe(cmd, args, timeoutMs, rt) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: MAX_RESULT_BYTES, timeout: timeoutMs, signal: rt.signal }, (err, stdout, stderr) => {
      if (rt.signal.aborted) return reject(rt.signal.reason);
      if (err) {
        if (err.code === 'ENOENT') return reject(new FleetError('SPAWN_FAILED', `could not start ${cmd}: ${err.message}`));
        if (err.killed) return reject(new FleetError('TIMEOUT', `ffprobe did not finish within ${timeoutMs} ms`));
        const tail = String(stderr).trim().slice(-2048) || null;
        return reject(new FleetError('FFPROBE_EXIT', `ffprobe exited with code ${err.code}`, { details: { exitCode: typeof err.code === 'number' ? err.code : null, stderrTail: tail } }));
      }
      resolve(stdout);
    });
    child.stdin?.end();
  });
}
