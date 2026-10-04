import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseDuration, interpolateEnv } from '../src/config.js';
import { parseYaml } from '../src/yaml.js';

const base = { pools: [{ name: 'local', provider: 'process' }] };

test('durations accept units and plain milliseconds', () => {
  assert.equal(parseDuration('10s'), 10000);
  assert.equal(parseDuration('5m'), 300000);
  assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration(250), 250);
  assert.throws(() => parseDuration('soon', 'x'), /not a duration/);
});

test('${NAME} comes from the environment; an unset one is an error unless it has a default', () => {
  assert.equal(interpolateEnv('a-${X}-b', { X: '1' }), 'a-1-b');
  assert.deepEqual(interpolateEnv({ k: ['${Y:-z}'] }, {}), { k: ['z'] });
  assert.throws(() => interpolateEnv('${NOPE}', {}), /NOPE is not set/);
});

test('defaults: min 0, max 1, slots auto, both kinds', () => {
  const c = normalizeConfig(base, {});
  const p = c.pools[0];
  assert.equal(p.min, 0);
  assert.equal(p.max, 1);
  assert.equal(p.slotsAuto, true);
  assert.deepEqual([...p.kinds].sort(), ['batch', 'stream']);
  assert.equal(c.autoscale.id, 'default');
  assert.equal(c.autoscale.maxWorkers, Infinity);
});

test('a full YAML document normalizes', () => {
  const c = normalizeConfig(parseYaml(`
publicUrl: https://orch.example.com/
autoscale:
  idleAfter: 10m
  maxWorkers: 8
pools:
  - name: home
    provider: process
    max: 2
    kinds: [batch]
    slots: auto:2
  - name: cloud
    provider: hetzner
    max: 4
    kinds: [stream]
    slots: { stream: 3 }
    env:
      AWS_ACCESS_KEY_ID: a
      AWS_SECRET_ACCESS_KEY: b
    hetzner:
      token: tok
      serverType: cpx31
`), {});
  assert.equal(c.publicUrl, 'https://orch.example.com');
  assert.equal(c.autoscale.idleAfter, 600000);
  assert.equal(c.pools[0].slots, 'auto:2');
  assert.deepEqual(c.pools[0].kinds, ['batch']);
  assert.equal(c.pools[1].slots, 'stream=3');
  assert.ok(c.pools[1].capabilities.includes('scheme:s3'));
  assert.equal(c.pools[1].options.workerImage, 'ghcr.io/jsilvanus/fffleet-worker:latest');
});

test('mistakes are named', () => {
  const bad = (doc, re) => assert.throws(() => normalizeConfig(doc, {}), re);
  bad({}, /at least one pool/);
  bad({ pools: [{ name: 'A b', provider: 'process' }] }, /name must be/);
  bad({ pools: [{ name: 'x', provider: 'nope' }] }, /provider must be one of/);
  bad({ pools: [base.pools[0], base.pools[0]] }, /used twice/);
  bad({ pools: [{ ...base.pools[0], min: 3, max: 1 }] }, /not below min/);
  bad({ pools: [{ ...base.pools[0], kinds: ['video'] }] }, /kinds/);
  bad({ pools: [{ ...base.pools[0], wat: 1 }] }, /unknown setting "wat"/);
  bad({ pools: [{ ...base.pools[0], docker: {} }] }, /has a "docker" block/);
  bad({ pools: [{ name: 'h', provider: 'hetzner', hetzner: { serverType: 'x' } }], publicUrl: 'http://o' }, /hetzner.token is required/);
  bad({ pools: [{ name: 'h', provider: 'hetzner', hetzner: { token: 't', serverType: 'x' } }] }, /publicUrl is required/);
  bad({ pools: [{ name: 'd', provider: 'docker' }], publicUrl: 'http://o' }, /docker.network is required/);
  bad({ autoscale: { interval: '10ms' }, ...base }, /at least 100ms/);
  bad({ autoscale: { bogus: 1 }, ...base }, /unknown setting "bogus"/);
});

test('max 0 retires a pool', () => {
  assert.equal(normalizeConfig({ pools: [{ ...base.pools[0], max: 0 }] }, {}).pools[0].max, 0);
});
