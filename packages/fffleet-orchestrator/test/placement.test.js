import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlacement, preferenceFor } from '../src/placement.js';
import { normalizeConfig } from '../src/config.js';

test('first matching rule wins; a job preference overrides', () => {
  const rules = normalizePlacement([
    { match: { type: 'dsk' }, workers: ['a', 'b'] },
    { match: { kind: 'stream', requires: 'device:hama' }, workers: ['pi'] },
    { workers: ['x'], others: true },
  ]);
  assert.deepEqual(preferenceFor(rules, { type: 'dsk', kind: 'batch' }), { workers: ['a', 'b'], others: false });
  assert.deepEqual(preferenceFor(rules, { type: 'ffmpeg', kind: 'stream', requires: ['device:hama'] }).workers, ['pi']);
  assert.deepEqual(preferenceFor(rules, { type: 'ffmpeg', kind: 'stream', requires: [] }), { workers: ['x'], others: true });
  assert.deepEqual(preferenceFor(rules, { type: 'dsk', workerPreference: ['z'] }), { workers: ['z'], others: false });
  assert.equal(preferenceFor([], { type: 'dsk' }), null);
});

test('placement mistakes are named; a config may have placement and no pools', () => {
  assert.throws(() => normalizePlacement({}), /must be a list/);
  assert.throws(() => normalizePlacement([{ workers: [] }]), /non-empty list/);
  assert.throws(() => normalizePlacement([{ workers: ['a', 'a'] }]), /unique/);
  assert.throws(() => normalizePlacement([{ match: { wat: 1 }, workers: ['a'] }]), /unknown setting "wat"/);
  const c = normalizeConfig({ placement: [{ match: { type: 'dsk' }, workers: ['a'] }] }, {});
  assert.deepEqual(c.pools, []);
  assert.equal(c.placement[0].workers[0], 'a');
});
