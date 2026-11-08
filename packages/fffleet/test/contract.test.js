import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, canonicalJson, isFinal, parseSpec, resolvePlaceholders, validateSpec, resolveVariant } from '../src/index.js';

const minimal = { kind: 'batch', ffmpeg: { args: ['-version'] } };

test('fills in defaults', () => {
  const spec = parseSpec(minimal);
  assert.deepEqual(spec, {
    contract: 1, id: undefined, kind: 'batch', type: 'ffmpeg', class: 'default', priority: 0, owner: '',
    requires: [], labels: {}, timeoutMs: null, stdin: false, stdout: false, inputs: [], outputs: [],
    ffmpeg: { args: ['-version'], durationMs: null },
  });
});

test('sorts and de-duplicates requires, drops unknown fields', () => {
  const spec = parseSpec({ ...minimal, requires: ['b', 'a', 'b'], surprise: true });
  assert.deepEqual(spec.requires, ['a', 'b']);
  assert.equal('surprise' in spec, false);
});

test('reports every problem with its path', () => {
  const r = validateSpec({ kind: 'nope', class: 'Bad Class', priority: 1.5, timeoutMs: -1, labels: { a: 1 }, ffmpeg: { args: [] } });
  assert.equal(r.ok, false);
  const paths = r.errors.map(e => e.path).sort();
  assert.deepEqual(paths, ['class', 'ffmpeg.args', 'kind', 'labels', 'priority', 'timeoutMs']);
});

test('rejects unknown contract versions, bad ids and non-objects', () => {
  assert.equal(validateSpec(null).ok, false);
  assert.equal(validateSpec([]).ok, false);
  assert.match(validateSpec({ ...minimal, contract: 2 }).errors[0].message, /unsupported contract version/);
  assert.equal(validateSpec({ ...minimal, id: 'has space' }).errors[0].path, 'id');
  assert.equal(validateSpec({ ...minimal, id: 'ok-id_1.2:x' }).ok, true);
});

test('checks endpoint names, uniqueness and schemes', () => {
  const r = validateSpec({
    kind: 'batch',
    inputs: [{ name: 'a', uri: 'file:///x' }, { name: 'a', uri: 'file:///y' }, { name: 'b', uri: 'ftp://host/x' }, { name: 'c', uri: 'not a uri' }],
    ffmpeg: { args: ['-i', '{{input:a}}'] },
  });
  assert.equal(r.ok, false);
  const msgs = r.errors.map(e => `${e.path} ${e.message}`);
  assert.ok(msgs.some(m => m.startsWith('inputs[1].name duplicate')));
  assert.ok(msgs.some(m => m.startsWith('inputs[2].uri scheme ftp:')));
  assert.ok(msgs.some(m => m.startsWith('inputs[3].uri must be an absolute URI')));
});

test('accepts every supported scheme', () => {
  const uris = ['file:///a', 'http://h/a', 'https://h/a', 'rtmp://h/a', 'rtmps://h/a', 'srt://h:1', 'udp://h:1', 'tcp://h:1', 'rtsp://h/a', 'rtp://h:1'];
  const r = validateSpec({ kind: 'stream', inputs: uris.map((uri, i) => ({ name: `i${i}`, uri })), ffmpeg: { args: ['x'] } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('placeholders must name a declared input or output', () => {
  const r = validateSpec({ kind: 'batch', outputs: [{ name: 'out', uri: 'file:///o.mp4' }], ffmpeg: { args: ['-i', '{{input:missing}}', '{{output:out}}'] } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, 'ffmpeg.args[1]');
});

test('parseSpec throws a ContractError with status 422', () => {
  assert.throws(() => parseSpec({}), err => err instanceof ContractError && err.status === 422 && err.code === 'INVALID_SPEC');
});

test('non-ffmpeg types keep their own section', () => {
  const spec = parseSpec({ kind: 'batch', type: 'custom', custom: { x: 1 } });
  assert.deepEqual(spec.custom, { x: 1 });
  assert.equal(spec.ffmpeg, undefined);
});

test('resolvePlaceholders substitutes inside arguments', () => {
  assert.deepEqual(
    resolvePlaceholders(['-i', '{{input:a}}', 'prefix={{output:b}}'], { input: { a: '/in.mp4' }, output: { b: '/out.mp4' } }),
    ['-i', '/in.mp4', 'prefix=/out.mp4'],
  );
  assert.throws(() => resolvePlaceholders(['{{input:x}}'], { input: {}, output: {} }), /unresolved/);
});

test('canonicalJson ignores key order and undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] }), canonicalJson({ a: [1, { d: 2 }], b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
});

test('isFinal', () => {
  assert.deepEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled'].map(isFinal), [false, false, true, true, true]);
});

test('redact is optional, validated and kept only when given', () => {
  const base = { id: 'r1', kind: 'stream', ffmpeg: { args: ['-i', 'rtsp://x/y', '-f', 'null', '-'] } };
  const plain = validateSpec(base);
  assert.equal(plain.ok, true);
  assert.equal('redact' in plain.spec, false);
  const ok = validateSpec({ ...base, redact: ['abcd1234', 'abcd1234', 'efgh5678'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.spec.redact, ['abcd1234', 'efgh5678']);
  assert.equal(validateSpec({ ...base, redact: ['abc'] }).ok, false);
  assert.equal(validateSpec({ ...base, redact: 'abcd1234' }).ok, false);
  assert.equal(validateSpec({ ...base, redact: Array(11).fill('abcd1234') }).ok, false);
});

test('workerPreference is optional, preserves order and rejects invalid lists', () => {
  const ordered = parseSpec({ ...minimal, workerPreference: ['assisting-pc', 'operator-pc', 'pi'] });
  assert.deepEqual(ordered.workerPreference, ['assisting-pc', 'operator-pc', 'pi']);
  assert.equal('workerPreference' in parseSpec(minimal), false);
  for (const value of [[], ['pi', 'pi'], ['pi', ''], ['pi', 3], 'pi']) {
    const result = validateSpec({ ...minimal, workerPreference: value });
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.ok(result.errors.some(e => e.path === 'workerPreference'));
  }
});

const streamWithVariants = {
  kind: 'stream', stdout: true,
  inputs: [{ name: 'cam', uri: 'rtsp://cam.local/analysis' }],
  ffmpeg: { args: ['-i', '{{input:cam}}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'] },
  labels: { app: 'x' },
  variants: [
    { name: 'remote', when: { workers: ['far'] }, ffmpeg: { args: ['-i', '{{input:cam}}', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'] }, labels: { format: 'mjpeg' } },
    { when: { capabilities: ['gpu', 'encoder:h264_nvenc'] }, ffmpeg: { args: ['-i', '{{input:cam}}', '-c:v', 'h264_nvenc', '-f', 'mpegts', 'pipe:1'] } },
  ],
};

test('variants: validated, named, kept on the spec', () => {
  const spec = parseSpec(streamWithVariants);
  assert.equal(spec.variants.length, 2);
  assert.equal(spec.variants[0].name, 'remote');
  assert.equal(spec.variants[1].name, 'variant-1');
  assert.deepEqual(spec.variants[1].when, { capabilities: ['gpu', 'encoder:h264_nvenc'] });
  assert.equal(spec.variants[1].ffmpeg.durationMs, null);
  assert.equal('variant' in spec, false);
});

test('variants: each merged result must be a valid spec; bad shapes are reported with their path', () => {
  const r = validateSpec({
    ...streamWithVariants,
    variants: [
      { when: {}, ffmpeg: { args: ['-i', '{{input:nope}}', 'pipe:1'] } },
      { name: 'a', when: { workers: [] }, requires: ['gpu'] },
      { name: 'a', when: { region: 'x' } },
      { when: { workers: ['w'] }, labels: 'no' },
    ],
  });
  assert.equal(r.ok, false);
  const paths = r.errors.map(e => e.path);
  for (const p of ['variants[0].when', 'variants[0].ffmpeg.args[1]', 'variants[1].when.workers', 'variants[1].requires', 'variants[2].name', 'variants[2].when.region', 'variants[3].labels']) {
    assert.ok(paths.includes(p), `${p} in ${paths.join(', ')}`);
  }
  assert.equal(validateSpec({ ...minimal, variants: [] }).ok, false);
  assert.equal(validateSpec({ ...minimal, variants: Array.from({ length: 17 }, () => ({ when: { workers: ['a'] } })) }).ok, false);
});

test('resolveVariant: first matching variant wins; workers match any, capabilities need all', () => {
  const spec = parseSpec(streamWithVariants);
  const far = resolveVariant(spec, { workerId: 'far', capabilities: ['gpu', 'encoder:h264_nvenc'] });
  assert.equal(far.variant, 'remote');
  assert.equal(far.spec.variant, 'remote');
  assert.equal('variants' in far.spec, false);
  assert.ok(far.spec.ffmpeg.args.includes('mjpeg'));
  assert.deepEqual(far.spec.labels, { app: 'x', format: 'mjpeg' });
  assert.deepEqual(far.spec.inputs, spec.inputs, 'inputs not set by the variant stay');

  const gpu = resolveVariant(spec, { workerId: 'box', capabilities: new Set(['gpu', 'encoder:h264_nvenc']) });
  assert.equal(gpu.variant, 'variant-1');
  const half = resolveVariant(spec, { workerId: 'box', capabilities: ['gpu'] });
  assert.equal(half.variant, null);
  assert.ok(half.spec.ffmpeg.args.includes('rawvideo'));
  assert.equal('variants' in half.spec, false);
  assert.equal('variant' in half.spec, false);

  // A resolved spec passes validation again unchanged (what a worker receives).
  assert.deepEqual(parseSpec(far.spec), far.spec);
});

test('variants of other executor types replace the type section', () => {
  const spec = parseSpec({ kind: 'batch', type: 'thing', thing: { mode: 'a' }, variants: [{ when: { workers: ['w'] }, thing: { mode: 'b' } }] });
  assert.deepEqual(resolveVariant(spec, { workerId: 'w' }).spec.thing, { mode: 'b' });
  assert.deepEqual(resolveVariant(spec, { workerId: 'v' }).spec.thing, { mode: 'a' });
});
