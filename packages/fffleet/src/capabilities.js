import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { siblingProbe } from './ffprobe.js';

const run = promisify(execFile);

/**
 * Lists what this machine can do, as capability strings matched against a spec's `requires`:
 * `type:ffmpeg`, `type:ffprobe`, `ffmpeg:<major.minor>`, `filter:<name>`, `encoder:<name>`, `font:<family>`.
 * Missing tools simply contribute nothing.
 *
 * @param {string} [ffmpegPath]
 * @returns {Promise<string[]>}
 */
export async function detectCapabilities(ffmpegPath = 'ffmpeg') {
  const caps = new Set();
  const out = async (cmd, args) => {
    try {
      return (await run(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 10000 })).stdout;
    } catch {
      return '';
    }
  };

  const version = await out(ffmpegPath, ['-hide_banner', '-version']);
  const v = version.match(/ffmpeg version n?(\d+)\.(\d+)/);
  if (version) caps.add('type:ffmpeg');
  if (await out(siblingProbe(ffmpegPath), ['-hide_banner', '-version'])) caps.add('type:ffprobe');
  if (v) caps.add(`ffmpeg:${v[1]}.${v[2]}`);

  // " T.. ass               V->V       Render ASS subtitles..."
  for (const line of (await out(ffmpegPath, ['-hide_banner', '-filters'])).split('\n')) {
    const m = line.match(/^\s[T.][S.][C.]\s+(\S+)\s+\S+->\S+/);
    if (m) caps.add(`filter:${m[1]}`);
  }
  // " V....D libx264              libx264 H.264 ..."
  for (const line of (await out(ffmpegPath, ['-hide_banner', '-encoders'])).split('\n')) {
    const m = line.match(/^\s[VAS][F.][S.][X.][B.][D.]\s+(\S+)\s/);
    if (m && m[1] !== '=') caps.add(`encoder:${m[1]}`);
  }
  for (const line of (await out('fc-list', [':', 'family'])).split('\n')) {
    for (const family of line.split(',')) if (family.trim()) caps.add(`font:${family.trim()}`);
  }
  return [...caps].sort();
}

/** True when every required capability is present. */
export function satisfies(capabilities, requires) {
  const have = capabilities instanceof Set ? capabilities : new Set(capabilities);
  return requires.every(r => have.has(r));
}
