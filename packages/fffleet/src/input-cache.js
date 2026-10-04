// A worker-side cache of staged inputs, so a large source is downloaded once and not for every job.

import { createHash, randomBytes } from 'node:crypto';
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** "500", "20MB", "50GB" (decimal units) as a number of bytes. */
export function parseSize(value) {
  if (typeof value === 'number') return value;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!m) throw new Error(`invalid size "${value}" (use for example 500MB or 50GB)`);
  const unit = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 }[(m[2] ?? 'b').toLowerCase()];
  return Math.round(Number(m[1]) * unit);
}

/**
 * @param {object} opts
 * @param {string} opts.dir           Where cached files live.
 * @param {number} [opts.maxBytes]    Least recently used files are removed above this. Default 20 GB.
 */
export function createInputCache({ dir, maxBytes = 20e9 }) {
  const hashOf = key => createHash('sha256').update(key).digest('hex').slice(0, 40);
  const stats = { hits: 0, misses: 0 };

  async function place(entry, target) {
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { force: true });
    try {
      await link(entry, target);
    } catch {
      await copyFile(entry, target); // another file system, or no hard links
    }
  }

  async function evict(keep) {
    let names;
    try {
      names = (await readdir(dir)).filter(n => n.endsWith('.json'));
    } catch {
      return;
    }
    const entries = [];
    let total = 0;
    for (const n of names) {
      const base = n.slice(0, -5);
      try {
        const [m, f] = await Promise.all([stat(join(dir, n)), stat(join(dir, `${base}.bin`))]);
        entries.push({ base, used: m.mtimeMs, size: f.size });
        total += f.size;
      } catch {
        // half-written or already removed
      }
    }
    entries.sort((a, b) => a.used - b.used);
    for (const e of entries) {
      if (total <= maxBytes) break;
      if (e.base === keep) continue;
      await rm(join(dir, `${e.base}.bin`), { force: true });
      await rm(join(dir, `${e.base}.json`), { force: true });
      total -= e.size;
    }
  }

  return {
    stats,

    /**
     * Puts the file for `key` at `target`: from the cache when its `validator` (an ETag or similar) still
     * matches, else by calling `download(path)` and keeping the result. Hard-links, so no copy is made.
     * @returns {Promise<'hit' | 'miss'>}
     */
    async stage({ key, validator, target, download }) {
      const base = hashOf(key);
      const entry = join(dir, `${base}.bin`);
      const metaPath = join(dir, `${base}.json`);
      await mkdir(dir, { recursive: true });
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        if (meta.validator === validator && (await stat(entry)).size === meta.size) {
          const now = new Date();
          await utimes(metaPath, now, now).catch(() => {});
          await place(entry, target);
          stats.hits++;
          return 'hit';
        }
      } catch {
        // not cached yet
      }
      const part = join(dir, `${base}.${randomBytes(4).toString('hex')}.part`);
      try {
        await download(part);
        const { size } = await stat(part);
        await rename(part, entry);
        await writeFile(metaPath, JSON.stringify({ key, validator, size }));
      } finally {
        await rm(part, { force: true });
      }
      await place(entry, target);
      stats.misses++;
      await evict(base);
      return 'miss';
    },
  };
}
