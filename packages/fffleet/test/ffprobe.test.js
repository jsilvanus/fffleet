// The built-in ffprobe job type with real ffprobe: local, http and (staged) s3 inputs, and its failure modes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobManager, detectCapabilities } from '../src/index.js';
import { close, listen } from '../src/server.js';
import { collect, tempDir } from './helpers.js';

let tmp, server, base, manager, video;

before(async () => {
  tmp = await tempDir();
  video = join(tmp.dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x48:r=10:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', '-pix_fmt', 'yuv420p', video]);
  const bytes = readFileSync(video);
  ({ server, url: base } = await listen((req, res) => {
    if (req.url === '/clip.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length });
      return res.end(bytes);
    }
    res.writeHead(404).end();
  }));
  manager = new JobManager({ workRoot: join(tmp.dir, 'work'), s3: { getFile: async (bucket, key, path) => execFileSync('cp', [video, path]) } });
});

after(async () => {
  manager.close?.();
  await close(server);
  await tmp.cleanup();
});

async function probe(spec) {
  const { job } = manager.submit({ kind: 'batch', type: 'ffprobe', ...spec });
  return (await collect(manager, job.id).done).at(-1);
}

test('probes a local file and returns the JSON inline', async () => {
  const last = await probe({ inputs: [{ name: 'in', uri: pathToFileURL(video).href }] });
  assert.equal(last.state, 'succeeded');
  const [out] = last.outputs;
  assert.equal(out.name, 'probe');
  assert.equal(out.uri, 'inline:');
  assert.ok(out.bytes > 0);
  assert.equal(out.data.streams.find(s => s.codec_type === 'video').width, 64);
  assert.ok(out.data.streams.find(s => s.codec_type === 'audio'));
  assert.ok(Number(out.data.format.duration) > 0.5);
});

test('probes an http input and honours ffprobe.show', async () => {
  const last = await probe({ inputs: [{ name: 'in', uri: `${base}/clip.mp4` }], ffprobe: { show: ['format'] } });
  assert.equal(last.state, 'succeeded');
  assert.ok(last.outputs[0].data.format);
  assert.equal(last.outputs[0].data.streams, undefined);
});

test('stages an s3 input before probing it', async () => {
  const last = await probe({ inputs: [{ name: 'in', uri: 's3://bucket/clips/a.mp4' }] });
  assert.equal(last.state, 'succeeded');
  assert.equal(last.outputs[0].data.streams.find(s => s.codec_type === 'video').height, 48);
});

test('a file that is not media fails with the ffprobe error', async () => {
  const text = join(tmp.dir, 'note.txt');
  execFileSync('sh', ['-c', `echo hello > ${text}`]);
  const last = await probe({ inputs: [{ name: 'in', uri: pathToFileURL(text).href }] });
  assert.equal(last.state, 'failed');
  assert.equal(last.error.code, 'FFPROBE_EXIT');
  assert.ok(last.stderrTail);
});

test('rejects specs with no input, two inputs, an output or a bad ffprobe.show', async () => {
  const file = pathToFileURL(video).href;
  for (const spec of [
    { inputs: [] },
    { inputs: [{ name: 'a', uri: file }, { name: 'b', uri: file }] },
    { inputs: [{ name: 'a', uri: file }], outputs: [{ name: 'o', uri: pathToFileURL(join(tmp.dir, 'o.json')).href }] },
    { inputs: [{ name: 'a', uri: file }], ffprobe: { show: ['everything'] } },
  ]) {
    const last = await probe(spec);
    assert.equal(last.state, 'failed', JSON.stringify(spec));
    assert.equal(last.error.code, 'INVALID_SPEC');
  }
});

test('workers advertise type:ffprobe only when ffprobe exists', async () => {
  assert.ok((await detectCapabilities('ffmpeg')).includes('type:ffprobe'));
  assert.ok(!(await detectCapabilities('/nonexistent/ffmpeg')).includes('type:ffprobe'));
});
