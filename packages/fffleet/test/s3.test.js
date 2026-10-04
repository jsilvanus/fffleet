// S3 staging against a real S3-compatible server. Runs when FFFLEET_TEST_S3_ENDPOINT is set
// (CI starts one); credentials from FFFLEET_TEST_S3_ACCESS_KEY / FFFLEET_TEST_S3_SECRET_KEY.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JobManager, createS3Client, parseSpec } from '../src/index.js';
import { averageColor, collect, near, tempDir } from './helpers.js';

const endpoint = process.env.FFFLEET_TEST_S3_ENDPOINT;
const skip = endpoint ? false : 'set FFFLEET_TEST_S3_ENDPOINT to run against an S3 server';
const config = {
  endpoint,
  region: 'us-east-1',
  pathStyle: true,
  accessKeyId: process.env.FFFLEET_TEST_S3_ACCESS_KEY ?? 'fffleetkey',
  secretAccessKey: process.env.FFFLEET_TEST_S3_SECRET_KEY ?? 'fffleetsecret',
};
const bucket = `fffleet-test-${Date.now().toString(36)}`;
let s3, tmp, manager;

before(async () => {
  if (skip) return;
  tmp = await tempDir();
  s3 = createS3Client(config);
  await s3.createBucket(bucket);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', join(tmp.dir, 'red.png')]);
  await s3.putFile(bucket, 'in/red.png', join(tmp.dir, 'red.png'));
  manager = new JobManager({ workRoot: join(tmp.dir, 'work'), s3: config });
});

after(async () => {
  await manager?.close();
  await tmp?.cleanup();
});

async function download(key) {
  const path = join(tmp.dir, `dl-${randomBytes(4).toString('hex')}`);
  await s3.getFile(bucket, key, path);
  return path;
}

test('round-trips small and multipart objects, including awkward key names', { skip }, async () => {
  const small = join(tmp.dir, 'small.bin');
  await writeFile(small, randomBytes(1000));
  await s3.putFile(bucket, "odd/space and (parens) ä!.bin", small);
  assert.deepEqual(await readFile(await download("odd/space and (parens) ä!.bin")), await readFile(small));

  // 11 MB in 5 MB parts: three parts, the last one short.
  const big = join(tmp.dir, 'big.bin');
  await writeFile(big, randomBytes(11 * 1024 * 1024));
  const multipart = createS3Client({ ...config, partSize: 5 * 1024 * 1024 });
  await multipart.putFile(bucket, 'big.bin', big, { forceMultipart: true });
  assert.ok((await readFile(await download('big.bin'))).equals(await readFile(big)));
});

test('wrong credentials are refused', { skip }, async () => {
  const bad = createS3Client({ ...config, secretAccessKey: 'wrong' });
  await assert.rejects(bad.getFile(bucket, 'in/red.png', join(tmp.dir, 'nope')), err => err.status === 403);
});

test('a batch job reads its input from S3 and writes its output to S3', { skip }, async () => {
  manager.submit({
    id: 's3-file', kind: 'batch',
    inputs: [{ name: 'src', uri: `s3://${bucket}/in/red.png` }],
    outputs: [{ name: 'dst', uri: `s3://${bucket}/out/small.png` }],
    ffmpeg: { args: ['-i', '{{input:src}}', '-vf', 'scale=16:16', '{{output:dst}}'] },
  });
  const events = await collect(manager, 's3-file').done;
  const final = events.at(-1);
  assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  assert.ok(events.some(e => e.state === 'staging') && events.some(e => e.state === 'uploading'));
  assert.ok(final.outputs[0].bytes > 0);
  assert.ok(near(await averageColor(await download('out/small.png')), [255, 0, 0]));
});

test('a folder output uploads every file ffmpeg writes, e.g. HLS', { skip }, async () => {
  manager.submit({
    id: 's3-hls', kind: 'batch',
    outputs: [{ name: 'hls', uri: `s3://${bucket}/vod/green/` }],
    ffmpeg: { args: ['-f', 'lavfi', '-i', 'color=c=0x00FF00:s=160x120:r=25:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_filename', '{{output:hls}}/seg%03d.ts', '{{output:hls}}/index.m3u8'] },
  });
  const final = (await collect(manager, 's3-hls').done).at(-1);
  assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  const playlist = await readFile(await download('vod/green/index.m3u8'), 'utf8');
  const segments = playlist.split('\n').filter(l => l.endsWith('.ts'));
  assert.ok(segments.length >= 3, playlist);
  assert.ok(near(await averageColor(await download(`vod/green/${segments[0]}`)), [0, 255, 0], 12));
  assert.ok(final.outputs[0].bytes > playlist.length);
});

test('a missing S3 input fails with INPUT_FAILED', { skip }, async () => {
  manager.submit({ id: 's3-missing', kind: 'batch', inputs: [{ name: 'src', uri: `s3://${bucket}/nope.png` }], ffmpeg: { args: ['-i', '{{input:src}}', '-f', 'null', '-'] } });
  const final = (await collect(manager, 's3-missing').done).at(-1);
  assert.equal(final.error.code, 'INPUT_FAILED');
  assert.match(final.error.message, /404|NoSuchKey/);
});

test('without S3 settings, s3: jobs are refused at submit', () => {
  const plain = new JobManager();
  assert.throws(() => plain.submit({ kind: 'batch', outputs: [{ name: 'o', uri: 's3://b/k.png' }], ffmpeg: { args: ['{{output:o}}'] } }), { code: 'UNSUPPORTED_SCHEME', status: 422 });
});

test('the contract checks s3: URIs', () => {
  assert.throws(() => parseSpec({ kind: 'stream', outputs: [{ name: 'o', uri: 's3://b/k' }], ffmpeg: { args: ['x'] } }), /only supported for batch/);
  assert.throws(() => parseSpec({ kind: 'batch', inputs: [{ name: 'i', uri: 's3://b/folder/' }], ffmpeg: { args: ['x'] } }), /one object/);
  assert.throws(() => parseSpec({ kind: 'batch', inputs: [{ name: 'i', uri: 's3://b' }], ffmpeg: { args: ['x'] } }), /need a key/);
  assert.doesNotThrow(() => parseSpec({ kind: 'batch', outputs: [{ name: 'o', uri: 's3://b/' }], ffmpeg: { args: ['x'] } }));
});

test('a worker cache keeps an S3 input between jobs', { skip }, async () => {
  const cached = new JobManager({ workRoot: join(tmp.dir, 'work-cache'), s3: config, cache: { dir: join(tmp.dir, 'cache') } });
  const submit = id => {
    cached.submit({
      id, kind: 'batch',
      inputs: [{ name: 'src', uri: `s3://${bucket}/in/red.png` }],
      outputs: [{ name: 'dst', uri: `s3://${bucket}/out/${id}.png` }],
      ffmpeg: { args: ['-i', '{{input:src}}', '-vf', 'scale=16:16', '{{output:dst}}'] },
    });
    return collect(cached, id).done;
  };
  assert.equal((await submit('cache-1')).at(-1).state, 'succeeded');
  assert.equal((await submit('cache-2')).at(-1).state, 'succeeded');
  assert.equal(cached.cache.stats.misses, 1);
  assert.equal(cached.cache.stats.hits, 1);
  await cached.close();
});
