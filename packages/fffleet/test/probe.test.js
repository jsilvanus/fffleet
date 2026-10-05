import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { canConnect, parseProbes, probeCapabilities } from '../src/index.js';

test('parseProbes accepts aliases, tcp:// prefixes, names, IPs and IPv6', () => {
  const [a, b, c, d] = parseProbes('mediamtx=10.1.2.3:8554, tcp://MediaMTX:8554 ,[::1]:99,db=Db.Internal:5432');
  assert.deepEqual(a.capabilities, ['net:10.1.2.3:8554', 'net:mediamtx']);
  assert.deepEqual(b.capabilities, ['net:mediamtx:8554', 'net:mediamtx'], 'a host name is advertised on its own too');
  assert.deepEqual(c.capabilities, ['net:[::1]:99'], 'an IP only with its port');
  assert.deepEqual(d.capabilities, ['net:db.internal:5432', 'net:db']);
  assert.deepEqual(parseProbes(undefined), []);
  assert.deepEqual(parseProbes(['x:1']).map(p => p.host), ['x']);
});

test('parseProbes rejects malformed entries', () => {
  for (const bad of ['host', 'host:0', 'host:70000', 'a b=host:1', '=host:1', 'host:port', 'http://host:1']) {
    assert.throws(() => parseProbes(bad), /probe/, bad);
  }
});

test('probeCapabilities lists only the hosts that connect', async () => {
  const server = createServer(s => s.end());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const up = server.address().port;
  const probes = parseProbes(`here=127.0.0.1:${up},gone=127.0.0.1:1`);
  assert.deepEqual(await probeCapabilities(probes, { timeoutMs: 1000 }), [`net:127.0.0.1:${up}`, 'net:here']);
  assert.equal(await canConnect('127.0.0.1', up), true);
  await new Promise(r => server.close(r));
  assert.deepEqual(await probeCapabilities(probes, { timeoutMs: 1000 }), []);
});

test('probeCapabilities uses an injected connector and dedupes', async () => {
  const seen = [];
  const caps = await probeCapabilities(parseProbes('a=h:1,a=h:1'), { connect: async (h, p) => (seen.push(`${h}:${p}`), true) });
  assert.deepEqual(caps, ['net:a', 'net:h:1']);
  assert.equal(seen.length, 2);
});
