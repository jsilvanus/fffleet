// Parser for ffmpeg's `-progress pipe:1` output: key=value lines, one block per `progress=` line.

/**
 * @param {(progress: import('./types.js').Progress & { end: boolean }) => void} onBlock
 * @param {{ durationMs?: number | null }} [opts]
 * @returns {(chunk: string | Buffer) => void}
 */
export function createProgressParser(onBlock, { durationMs = null } = {}) {
  let buffer = '';
  let block = {};
  return chunk => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      block[key] = line.slice(eq + 1);
      if (key === 'progress') {
        onBlock(toProgress(block, durationMs));
        block = {};
      }
    }
  };
}

function num(v) {
  if (v === undefined || v === 'N/A' || v === '') return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function toProgress(b, durationMs) {
  // out_time_ms is microseconds despite its name; out_time_us is the same value.
  const us = num(b.out_time_us) ?? num(b.out_time_ms);
  const outTimeMs = us === null ? null : Math.max(0, Math.round(us / 1000));
  const pct = durationMs && outTimeMs !== null ? Math.min(100, Math.round((outTimeMs / durationMs) * 1000) / 10) : null;
  return {
    pct,
    outTimeMs,
    speed: num(b.speed),
    fps: num(b.fps),
    frame: num(b.frame),
    end: b.progress === 'end',
  };
}
