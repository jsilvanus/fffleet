import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../src/yaml.js';

test('maps, nested maps, scalars and comments', () => {
  const doc = parseYaml(`
# a comment
publicUrl: https://orch.example.org:5000   # trailing comment
count: 3
ratio: 1.5
on: true
off: false
nothing: ~
empty:
quoted: "a # not a comment, with \\"quotes\\""
single: 'it''s'
version: 1.2.3
nested:
  deeper:
    key: value
  other: x
`);
  assert.deepEqual(doc, {
    publicUrl: 'https://orch.example.org:5000',
    count: 3,
    ratio: 1.5,
    on: true,
    off: false,
    nothing: null,
    empty: null,
    quoted: 'a # not a comment, with "quotes"',
    single: "it's",
    version: '1.2.3',
    nested: { deeper: { key: 'value' }, other: 'x' },
  });
});

test('block sequences of scalars and of mappings, indented or not', () => {
  assert.deepEqual(parseYaml('a:\n  - 1\n  - two\n  - "three"\nb:\n- x\n- y\n'), { a: [1, 'two', 'three'], b: ['x', 'y'] });
  const doc = parseYaml(`
pools:
  - name: local
    provider: process
    workers:
      min: 1
      max: 2
  - name: cloud
    provider: hetzner
    env:
      A: 1
`);
  assert.deepEqual(doc, {
    pools: [
      { name: 'local', provider: 'process', workers: { min: 1, max: 2 } },
      { name: 'cloud', provider: 'hetzner', env: { A: 1 } },
    ],
  });
  assert.deepEqual(parseYaml('- a\n-\n  b: 1\n'), ['a', { b: 1 }]);
});

test('flow sequences and mappings', () => {
  assert.deepEqual(parseYaml('kinds: [batch, stream]\nslots: { default: 4, stream: 2 }\nempty: []\nnone: {}\ncaps: ["font:DejaVu Sans", filter:ass]'), {
    kinds: ['batch', 'stream'],
    slots: { default: 4, stream: 2 },
    empty: [],
    none: {},
    caps: ['font:DejaVu Sans', 'filter:ass'],
  });
  assert.deepEqual(parseYaml('x: [1, [2, 3], {a: b}]'), { x: [1, [2, 3], { a: 'b' }] });
});

test('values with colons and urls stay strings', () => {
  assert.deepEqual(parseYaml('url: http://127.0.0.1:5000/path\ntime: 12:30\nlist:\n  - ghcr.io/jsilvanus/fffleet-worker:latest'), {
    url: 'http://127.0.0.1:5000/path',
    time: '12:30',
    list: ['ghcr.io/jsilvanus/fffleet-worker:latest'],
  });
});

test('JSON is valid input', () => {
  assert.deepEqual(parseYaml('{"pools": [{"name": "a", "max": 2}], "x": null}'), { pools: [{ name: 'a', max: 2 }], x: null });
});

test('unsupported and broken input is rejected with a line number', () => {
  assert.throws(() => parseYaml('a: |\n  text'), /line 1.*not supported/);
  assert.throws(() => parseYaml('a: &x 1'), /not supported/);
  assert.throws(() => parseYaml('a:\n\tb: 1'), /line 2.*tabs/);
  assert.throws(() => parseYaml('a: 1\na: 2'), /line 2.*duplicate key "a"/);
  assert.throws(() => parseYaml('a: [1, 2'), /line 1/);
  assert.throws(() => parseYaml('a: "open'), /line 1.*unterminated/);
  assert.throws(() => parseYaml('a: 1\n---\nb: 2'), /multiple documents/);
  assert.throws(() => parseYaml('a: 1\n   b: 2'), /line 2/);
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('# only a comment\n'), null);
});
