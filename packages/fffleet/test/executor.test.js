// The ffmpeg executor with real ffmpeg: HTTP inputs are fetched first and HTTP outputs uploaded after.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobManager } from '../src/index.js';
import { close, listen } from '../src/server.js';
import { averageColor, collect, near, tempDir } from './helpers.js';

let tmp, server, base, manager;
const uploads = new Map();
let failUploads = false;

before(async () => {
  tmp = await tempDir();
  const red = join(tmp.dir, 'red.png');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', red]);
  const redBytes = readFileSync(red);
  ({ server, url: base } = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/in/red.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(redBytes);
    }
    if (req.method === 'PUT' && req.url.startsWith('/out/')) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (failUploads) {
          res.writeHead(500);
          return res.end();
        }
        uploads.set(req.url, { body: Buffer.concat(chunks), type: req.headers['content-type'] });
        res.writeHead(201);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }));
  manager = new JobManager({ slots: { default: 4 }, workRoot: join(tmp.dir, 'work') });
});

after(async () => {
  await manager.close();
  await close(server);
  await tmp.cleanup();
});

/** Scales an input image to a 16x16 png output. */
const scaleJob = (id, input, output, extra = {}) => ({
  id, kind: 'batch',
  inputs: [{ name: 'src', uri: input }],
  outputs: [{ name: 'dst', uri: output, contentType: 'image/png' }],
  ffmpeg: { args: ['-i', '{{input:src}}', '-vf', 'scale=16:16', '-frames:v', '1', '{{output:dst}}'] },
  ...extra,
});

async function run(spec) {
  const { events, done } = collect(manager, (manager.submit(spec), spec.id));
  await done;
  return { events, final: events.at(-1) };
}

test('fetches an http input, runs ffmpeg and PUTs the http output', async () => {
  const { events, final } = await run(scaleJob('http', `${base}/in/red.png`, `${base}/out/small.png`));
  assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  assert.deepEqual(events.map(e => e.state).filter((s, i, a) => s !== a[i - 1]), ['queued', 'staging', 'running', 'uploading', 'succeeded']);
  const up = uploads.get('/out/small.png');
  assert.ok(up, 'output uploaded');
  assert.equal(up.type, 'image/png');
  assert.equal(final.outputs[0].bytes, up.body.length);
  const local = join(tmp.dir, 'uploaded.png');
  writeFileSync(local, up.body);
  assert.ok(near(await averageColor(local), [255, 0, 0]));
});

test('file inputs and outputs are used in place', async () => {
  const out = join(tmp.dir, 'nested', 'dir', 'small.png');
  const { final } = await run(scaleJob('files', pathToFileURL(join(tmp.dir, 'red.png')).href, pathToFileURL(out).href));
  assert.equal(final.state, 'succeeded');
  assert.equal(final.outputs[0].uri, pathToFileURL(out).href);
  assert.ok(near(await averageColor(out), [255, 0, 0]));
});

test('a missing http input fails with INPUT_FAILED before ffmpeg runs', async () => {
  const { events, final } = await run(scaleJob('nohttp', `${base}/in/missing.png`, `${base}/out/x.png`));
  assert.equal(final.error.code, 'INPUT_FAILED');
  assert.ok(!events.some(e => e.state === 'running'));
});

test('a missing file input fails with INPUT_FAILED', async () => {
  const { final } = await run(scaleJob('nofile', pathToFileURL(join(tmp.dir, 'nope.png')).href, pathToFileURL(join(tmp.dir, 'x.png')).href));
  assert.equal(final.error.code, 'INPUT_FAILED');
});

test('a failed upload fails the job with UPLOAD_FAILED', async () => {
  failUploads = true;
  try {
    const { final } = await run(scaleJob('upfail', `${base}/in/red.png`, `${base}/out/fail.png`));
    assert.equal(final.error.code, 'UPLOAD_FAILED');
  } finally {
    failUploads = false;
  }
});

test('a batch output ffmpeg never wrote fails with OUTPUT_MISSING', async () => {
  const { final } = await run({
    id: 'missing-out', kind: 'batch',
    outputs: [{ name: 'dst', uri: pathToFileURL(join(tmp.dir, 'never.png')).href }],
    ffmpeg: { args: ['-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=0.1', '-f', 'null', '-'] },
  });
  assert.equal(final.error.code, 'OUTPUT_MISSING');
});

test('a missing ffmpeg binary fails with SPAWN_FAILED', async () => {
  const m = new JobManager({ ffmpegPath: join(tmp.dir, 'no-ffmpeg'), workRoot: join(tmp.dir, 'work2') });
  m.submit({ id: 'nobin', kind: 'batch', ffmpeg: { args: ['-version'] } });
  const final = (await collect(m, 'nobin').done).at(-1);
  assert.equal(final.error.code, 'SPAWN_FAILED');
  await m.close();
});
