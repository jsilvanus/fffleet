import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, canonicalJson, isFinal, parseSpec, resolvePlaceholders, validateSpec } from '../src/index.js';

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
