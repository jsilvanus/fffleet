import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { preferenceFor } from '../src/placement.js';

const { placement } = loadConfig(new URL('../../../deploy/pi/fffleet.yaml', import.meta.url).pathname);

test('deploy/pi placement: usb jobs only on the Pi', () => {
  assert.deepEqual(preferenceFor(placement, { type: 'ffmpeg', kind: 'batch', requires: ['usb'] }), { workers: ['pi'], others: false });
});

test('deploy/pi placement: dsk never goes to the Pi, normal stream jobs end on the Pi', () => {
  assert.deepEqual(preferenceFor(placement, { type: 'dsk', kind: 'stream' }).workers, ['operator-pc', 'assisting-pc']);
  assert.deepEqual(preferenceFor(placement, { type: 'ffmpeg', kind: 'stream', requires: ['normal'] }).workers, ['operator-pc', 'assisting-pc', 'pi']);
});
