import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import executor, { readPayload, scrub } from '../src/executors/download.js';
import { installFakeYtDlp } from './helpers/fake-ytdlp.js';

const COOKIES = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-cookie-value-123\n';
let dir;
let bucketDir;
let origPath;
let n = 0;

function diskS3(root) {
  const file = (b, k) => path.join(root, b, k);
  return {
    async getFile(b, k, to) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(file(b, k), to);
    },
    async putFile(b, k, from) {
      await mkdir(path.dirname(file(b, k)), { recursive: true });
      await copyFile(from, file(b, k));
      return (await stat(from)).size;
    },
  };
}

function runtime() {
  const abort = new AbortController();
  const events = [];
  const pcts = [];
  const workDir = path.join(dir, `work${n++}`);
  const rt = { workDir, signal: abort.signal, setState: s => events.push(s), progress: p => pcts.push(p.pct), s3: diskS3(bucketDir) };
  return { rt, abort, events, pcts, workDir };
}

const spec = (over = {}) => ({
  id: 'j1',
  download: { url: 'https://www.youtube.com/watch?v=abc' },
  inputs: [],
  outputs: [{ name: 'video', uri: 's3://b/out/video.mp4' }],
  ...over,
});
const withCookies = () => ({ inputs: [{ name: 'cookies', uri: 's3://b/in/cookies.txt' }] });

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dl-exec-'));
  bucketDir = path.join(dir, 'bucket');
  origPath = process.env.PATH;
  process.env.PATH = `${await installFakeYtDlp(dir)}${path.delimiter}${origPath}`;
});
after(async () => {
  process.env.PATH = origPath;
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const k of ['FAKE_YTDLP_MODE', 'FAKE_YTDLP_LOG', 'FAKE_YTDLP_PID', 'FAKE_YTDLP_TOUCH_COOKIES']) delete process.env[k];
  await mkdir(path.join(bucketDir, 'b/in'), { recursive: true });
  await writeFile(path.join(bucketDir, 'b/in/cookies.txt'), COOKIES);
});

// The stand-in yt-dlp is a POSIX script; Windows cannot spawn it without a shell, and the executor never uses one.
// Workers that run downloads are Linux (docker/worker-ytdlp.Dockerfile). Payload and scrub tests below run everywhere.
describe('download executor', { skip: process.platform === 'win32' && 'needs a POSIX yt-dlp stub' }, () => {
  test('is a download-type executor', () => {
    assert.equal(executor.type, 'download');
    assert.equal(typeof executor.run, 'function');
  });

  test('downloads to the video output and reports progress', async () => {
    const { rt, pcts, events } = runtime();
    const result = await executor.run(spec(), rt);
    assert.deepEqual(result.outputs.map(o => o.name), ['video']);
    assert.match(await readFile(path.join(bucketDir, 'b/out/video.mp4'), 'utf8'), /FAKE-MP4:https:\/\/www\.youtube\.com\/watch\?v=abc/);
    assert.deepEqual(pcts, [10, 55.5, 100]);
    assert.ok(events.includes('uploading'));
  });

  test('copies the cookie file into the work dir and passes the copy, not the original', async () => {
    process.env.FAKE_YTDLP_LOG = path.join(dir, 'args.log');
    const { rt, workDir } = runtime();
    await executor.run(spec(withCookies()), rt);
    const lines = (await readFile(process.env.FAKE_YTDLP_LOG, 'utf8')).trim().split('\n');
    const args = JSON.parse(lines.at(-1));
    assert.ok(args[args.indexOf('--cookies') + 1].startsWith(workDir));
    assert.equal(await readFile(path.join(bucketDir, 'b/in/cookies.txt'), 'utf8'), COOKIES);
  });

  test('returns updated cookies in cookies-out only when yt-dlp changed them', async () => {
    const s = spec({ ...withCookies(), outputs: [{ name: 'video', uri: 's3://b/out/v2.mp4' }, { name: 'cookies-out', uri: 's3://b/out/cookies-out.txt' }] });
    const unchanged = await executor.run(s, runtime().rt);
    assert.deepEqual(unchanged.outputs.map(o => o.name), ['video']);
    assert.equal(existsSync(path.join(bucketDir, 'b/out/cookies-out.txt')), false);
    process.env.FAKE_YTDLP_TOUCH_COOKIES = '1';
    const changed = await executor.run(s, runtime().rt);
    assert.deepEqual(changed.outputs.map(o => o.name), ['video', 'cookies-out']);
    assert.match(await readFile(path.join(bucketDir, 'b/out/cookies-out.txt'), 'utf8'), /FRESH/);
  });

  test('never puts cookie contents or the cookie path into the error', async () => {
    process.env.FAKE_YTDLP_MODE = 'fail';
    const { rt, workDir } = runtime();
    const err = await executor.run(spec(withCookies()), rt).catch(e => e);
    assert.ok(err instanceof Error);
    const text = `${err.message} ${JSON.stringify(err)}`;
    assert.match(text, /exited with code 3/);
    assert.match(text, /Sign in to confirm/);
    assert.ok(!text.includes('secret-cookie-value-123'));
    assert.ok(!text.includes(workDir));
    assert.equal(err.code, 'YTDLP_EXIT');
  });

  test('gives a readable error on a non-zero exit without cookies', async () => {
    process.env.FAKE_YTDLP_MODE = 'fail';
    await assert.rejects(executor.run(spec(), runtime().rt), /yt-dlp exited with code 3: ERROR: Sign in/);
  });

  test('kills yt-dlp when the signal aborts', async () => {
    process.env.FAKE_YTDLP_MODE = 'hang';
    process.env.FAKE_YTDLP_PID = path.join(dir, 'hang.pid');
    const { rt, abort } = runtime();
    const reason = new Error('cancelled');
    const done = executor.run(spec(), rt).catch(e => e);
    for (let i = 0; i < 100 && !existsSync(process.env.FAKE_YTDLP_PID); i++) await new Promise(r => setTimeout(r, 50));
    const pid = Number(await readFile(process.env.FAKE_YTDLP_PID, 'utf8'));
    abort.abort(reason);
    assert.equal(await done, reason);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise(r => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);
  });

  test('explains a missing yt-dlp binary', async () => {
    const saved = process.env.YTDLP_PATH;
    process.env.YTDLP_PATH = path.join(dir, 'nope');
    try {
      await assert.rejects(executor.run(spec(), runtime().rt), /yt-dlp is not installed/);
    } finally {
      if (saved === undefined) delete process.env.YTDLP_PATH;
      else process.env.YTDLP_PATH = saved;
    }
  });
});

describe('payload validation and scrubbing', () => {
  test('requires an http(s) url and rejects dangerous yt-dlp options', () => {
    assert.throws(() => readPayload({ download: { url: 'file:///etc/passwd' } }), /http/);
    assert.throws(() => readPayload({}), /required/);
    assert.throws(() => readPayload({ download: { url: 'https://x.test/v', extraArgs: ['--exec', 'rm -rf /'] } }), /not allowed/);
    assert.throws(() => readPayload({ download: { url: 'https://x.test/v', extraArgs: ['--cookies=/etc/x'] } }), /not allowed/);
    assert.deepEqual(readPayload({ download: { url: 'https://x.test/v', extraArgs: ['--limit-rate', '5M'], format: 'b' } }), {
      url: 'https://x.test/v',
      format: 'b',
      extraArgs: ['--limit-rate', '5M'],
    });
  });

  test('scrub removes the path, secrets and cookie-shaped lines', () => {
    const out = scrub('see /w/cookies.txt token abcdef123\n.a.com\tTRUE\t/\tTRUE\t0\tN\tV\nplain', { cookiePath: '/w/cookies.txt', secrets: ['abcdef123'] });
    assert.equal(out, 'see <cookies> token [redacted]\nplain');
  });
});
