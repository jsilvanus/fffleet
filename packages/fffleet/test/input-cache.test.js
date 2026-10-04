// {{inputdir:name}} and the worker's input cache, with real ffmpeg and a small HTTP server.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobManager, parseSpec, parseSize, resolvePlaceholders } from '../src/index.js';
import { close, listen } from '../src/server.js';
import { collect, tempDir } from './helpers.js';

let tmp, server, base, redBytes, redEtag = '"v1"';
const hits = { get: 0, head: 0 };

before(async () => {
  tmp = await tempDir();
  const red = join(tmp.dir, 'red.png');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', red]);
  redBytes = readFileSync(red);
  ({ server, url: base } = await listen((req, res) => {
    if (req.url.split('?')[0] === '/red.png') {
      hits[req.method === 'HEAD' ? 'head' : 'get']++;
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': redBytes.length, etag: redEtag });
      return res.end(req.method === 'HEAD' ? undefined : redBytes);
    }
    res.writeHead(404);
    res.end();
  }));
});

after(async () => {
  await close(server);
  await tmp.cleanup();
});

const job = (id, out) => ({
  id, kind: 'batch',
  inputs: [{ name: 'src', uri: `${base}/red.png` }],
  outputs: [{ name: 'dst', uri: pathToFileURL(join(tmp.dir, out)).href }],
  ffmpeg: { args: ['-i', '{{input:src}}', '-vf', 'scale=16:16', '{{output:dst}}'] },
});

async function run(manager, spec) {
  manager.submit(spec);
  const final = (await collect(manager, spec.id).done).at(-1);
  assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
}

test('{{inputdir:name}} is the directory holding only that input', () => {
  const spec = parseSpec({
    id: 'dir', kind: 'batch', inputs: [{ name: 'font', uri: 'https://x/f.ttf' }],
    ffmpeg: { args: ['-vf', "ass=a.ass:fontsdir='{{inputdir:font}}'"] },
  });
  assert.equal(spec.ffmpeg.args[1], "ass=a.ass:fontsdir='{{inputdir:font}}'");
  assert.equal(resolvePlaceholders(spec.ffmpeg.args, { input: {}, inputdir: { font: '/w/in/font' }, output: {} })[1], "ass=a.ass:fontsdir='/w/in/font'");
  assert.throws(() => parseSpec({ id: 'x', kind: 'batch', inputs: [], ffmpeg: { args: ['{{inputdir:nope}}'] } }), /names no inputdir/);
  assert.throws(() => resolvePlaceholders(['{{inputdir:font}}'], { input: {}, output: {} }), /unresolved/);
});

test('each staged input sits in its own directory, which {{inputdir:name}} resolves to', async () => {
  const fake = join(tmp.dir, 'fake-ffmpeg.sh');
  writeFileSync(fake, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS"\nfor last; do :; done\n: > "$last"\n');
  chmodSync(fake, 0o755);
  process.env.FAKE_ARGS = join(tmp.dir, 'args.txt');
  const manager = new JobManager({ workRoot: join(tmp.dir, 'w1'), ffmpegPath: fake });
  await run(manager, {
    id: 'own-dir', kind: 'batch',
    inputs: [{ name: 'a', uri: `${base}/red.png` }, { name: 'b', uri: `${base}/red.png` }],
    outputs: [{ name: 'dst', uri: pathToFileURL(join(tmp.dir, 'own.out')).href }],
    ffmpeg: { args: ['-i', '{{input:a}}', '-i', '{{input:b}}', '-vf', 'fontsdir={{inputdir:a}}', '{{output:dst}}'] },
  });
  const args = readFileSync(process.env.FAKE_ARGS, 'utf8').split('\n');
  const [a, b] = [args[args.indexOf('-i') + 1], args[args.lastIndexOf('-i') + 1]];
  assert.match(a, /[/\\]in[/\\]a[/\\]file\.png$/);
  assert.match(b, /[/\\]in[/\\]b[/\\]file\.png$/);
  assert.equal(args.find(x => x.startsWith('fontsdir=')), `fontsdir=${dirname(a)}`);
  await manager.close();
});

test('parseSize understands units', () => {
  assert.equal(parseSize('500'), 500);
  assert.equal(parseSize('20MB'), 20e6);
  assert.equal(parseSize('1.5gb'), 1.5e9);
  assert.throws(() => parseSize('lots'), /invalid size/);
});

test('the cache downloads once, rechecks the ETag, and downloads again when it changes', async () => {
  const cacheDir = join(tmp.dir, 'cache');
  const manager = new JobManager({ workRoot: join(tmp.dir, 'w2'), cache: { dir: cacheDir, maxBytes: '1MB' } });
  hits.get = hits.head = 0;
  await run(manager, job('c1', 'c1.png'));
  await run(manager, job('c2', 'c2.png'));
  assert.equal(hits.get, 1, 'the second job reused the cached file');
  assert.equal(hits.head, 2, 'each job checks the ETag first');
  assert.equal(manager.cache.stats.hits, 1);
  assert.ok(existsSync(join(tmp.dir, 'c2.png')));
  redEtag = '"v2"';
  await run(manager, job('c3', 'c3.png'));
  assert.equal(hits.get, 2, 'a changed ETag means a new download');
  await manager.close();
});

test('without a validator nothing is cached, and the cache stays within maxBytes', async () => {
  const cacheDir = join(tmp.dir, 'cache2');
  const manager = new JobManager({ workRoot: join(tmp.dir, 'w3'), cache: { dir: cacheDir, maxBytes: 1 } });
  redEtag = '"v3"';
  await run(manager, job('e1', 'e1.png'));
  const files = readdirSync(cacheDir).filter(n => n.endsWith('.bin'));
  assert.equal(files.length, 1, 'the entry just used is kept even when over the limit');
  await run(manager, { ...job('e2', 'e2.png'), inputs: [{ name: 'src', uri: `${base}/red.png?other=1` }] });
  assert.equal(readdirSync(cacheDir).filter(n => n.endsWith('.bin')).length, 1, 'the older entry was evicted');
  await manager.close();
});
