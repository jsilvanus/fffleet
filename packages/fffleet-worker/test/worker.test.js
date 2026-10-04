import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { close, listen } from 'fffleet/server';
import { createWorker } from '../src/worker.js';

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fffleet-worker-'));
});
after(() => rm(tmp, { recursive: true, force: true }));

const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 10));
  }
};

/** A stand-in orchestrator that records registrations. */
async function fakeOrchestrator({ status = 200 } = {}) {
  const calls = [];
  const { server, url } = await listen((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || 'null') });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return { calls, url, stop: () => close(server) };
}

test('serves the job API, detects capabilities and runs a job', async () => {
  const w = createWorker({ id: 'w1', port: 0, host: '127.0.0.1', token: 't', workRoot: join(tmp, 'w1'), extraCapabilities: ['site:test'] });
  await w.start();
  try {
    assert.ok(w.capabilities.includes('type:ffmpeg'));
    assert.ok(w.capabilities.includes('site:test'));
    assert.ok(w.capabilities.some(c => c.startsWith('encoder:')));
    const caps = await (await fetch(`${w.url}/v1/capabilities`, { headers: { authorization: 'Bearer t' } })).json();
    assert.equal(caps.id, 'w1');
    assert.deepEqual(caps.slots, { default: { total: 2, used: 0 } });

    const res = await fetch(`${w.url}/v1/jobs`, {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'null-out', kind: 'batch', ffmpeg: { args: ['-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=0.2', '-f', 'null', '-'] } }),
    });
    assert.equal(res.status, 201);
    await until(async () => (await (await fetch(`${w.url}/v1/jobs/null-out`, { headers: { authorization: 'Bearer t' } })).json()).state === 'succeeded');
    const job = w.manager.get('null-out');
    assert.equal(job.workerId, 'w1');
  } finally {
    await w.stop();
  }
});

test('registers with the orchestrator and heartbeats its active jobs', async () => {
  const orch = await fakeOrchestrator();
  const w = createWorker({
    id: 'w2', port: 0, host: '127.0.0.1', slots: 'default=1,stream=2', workRoot: join(tmp, 'w2'),
    orchestratorUrl: orch.url, orchestratorToken: 'wt', heartbeatMs: 50, extraCapabilities: ['x:y'],
  });
  await w.start();
  try {
    w.manager.submit({ id: 'live', kind: 'stream', class: 'stream', ffmpeg: { args: ['-re', '-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-f', 'null', '-'] } });
    await until(() => orch.calls.some(c => c.body.active.includes('live')));
    const first = orch.calls[0];
    assert.equal(first.path, '/v1/workers/register');
    assert.equal(first.auth, 'Bearer wt');
    assert.equal(first.body.id, 'w2');
    assert.equal(first.body.url, w.url);
    assert.deepEqual(first.body.slots, { default: 1, stream: 2 });
    assert.ok(first.body.capabilities.includes('x:y'));
    assert.match(first.body.version, /^\d+\.\d+\.\d+/);
  } finally {
    await w.stop();
    await orch.stop();
  }
  assert.equal(w.manager.get('live').state, 'cancelled', 'stop cancels running jobs');
});

test('advertiseUrl is what the orchestrator is told to call', async () => {
  const orch = await fakeOrchestrator();
  const w = createWorker({ id: 'w3', port: 0, host: '127.0.0.1', workRoot: join(tmp, 'w3'), orchestratorUrl: orch.url, advertiseUrl: 'http://worker-3.internal:5100', heartbeatMs: 1000 });
  await w.start();
  try {
    await until(() => orch.calls.length > 0);
    assert.equal(orch.calls[0].body.url, 'http://worker-3.internal:5100');
  } finally {
    await w.stop();
    await orch.stop();
  }
});

test('starts even when the orchestrator is down, and keeps trying', async () => {
  const orch = await fakeOrchestrator({ status: 503 });
  const logs = [];
  const w = createWorker({ id: 'w4', port: 0, host: '127.0.0.1', workRoot: join(tmp, 'w4'), orchestratorUrl: orch.url, heartbeatMs: 30, log: m => logs.push(m) });
  await w.start();
  try {
    await until(() => orch.calls.length >= 3);
    assert.ok(logs.some(l => l.includes('first registration failed')));
  } finally {
    await w.stop();
    await orch.stop();
  }
});
