import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { JobManager, followJobEvents, readSse } from '../src/index.js';
import { close, createApiHandler, listen } from '../src/server.js';
import { fakeExecutor, fakeSpec, tempDir, until } from './helpers.js';

const TOKEN = 'tok';
let tmp, manager, fake, server, url;

before(async () => {
  tmp = await tempDir();
  fake = fakeExecutor();
  manager = new JobManager({ slots: { default: 1 }, workRoot: join(tmp.dir, 'work'), executors: { fake: fake.executor }, progressIntervalMs: 0 });
  const backend = {
    submit: s => manager.submit(s),
    get: id => manager.get(id),
    list: () => manager.list(),
    cancel: id => manager.cancel(id),
    writeStdin: (id, d) => manager.writeStdin(id, d),
    subscribe: (id, a, fn) => manager.subscribe(id, a, fn),
    capabilities: () => ({ slots: manager.stats().pools, capabilities: ['type:fake'] }),
  };
  ({ server, url } = await listen(createApiHandler({ backend, token: TOKEN })));
});

after(async () => {
  await manager.close();
  await close(server);
  await tmp.cleanup();
});

async function call(path, { method = 'GET', body, token = TOKEN, raw } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

test('health needs no token; everything else does', async () => {
  assert.equal((await call('/v1/health', { token: null })).status, 200);
  assert.equal((await call('/v1/jobs', { token: null })).status, 401);
  assert.equal((await call('/v1/jobs', { token: 'wrong' })).status, 401);
  assert.equal((await call('/v1/capabilities')).body.capabilities[0], 'type:fake');
});

test('POST /v1/jobs: 201 started, 202 queued, 200 repeat, 409 conflict, 422 invalid, 400 bad json', async () => {
  assert.equal((await call('/v1/jobs', { method: 'POST', body: fakeSpec('one') })).status, 201);
  const queued = await call('/v1/jobs', { method: 'POST', body: fakeSpec('two') });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.state, 'queued');
  assert.equal((await call('/v1/jobs', { method: 'POST', body: fakeSpec('two') })).status, 200);
  const conflict = await call('/v1/jobs', { method: 'POST', body: fakeSpec('two', { priority: 3 }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'ID_CONFLICT');
  const invalid = await call('/v1/jobs', { method: 'POST', body: { kind: 'nope' } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'INVALID_SPEC');
  assert.ok(invalid.body.error.details.length > 0);
  assert.equal((await call('/v1/jobs', { method: 'POST', raw: '{nope' })).status, 400);
  assert.equal((await call('/v1/jobs')).body.jobs.length, 2);
  await call('/v1/jobs/one', { method: 'DELETE' });
  await call('/v1/jobs/two', { method: 'DELETE' });
});

test('GET and DELETE a job; 404 for unknown ids and routes', async () => {
  assert.equal((await call('/v1/jobs/missing')).status, 404);
  assert.equal((await call('/v1/jobs/missing', { method: 'DELETE' })).status, 404);
  assert.equal((await call('/v1/nothing')).status, 404);
  await call('/v1/jobs', { method: 'POST', body: fakeSpec('del') });
  const del = await call('/v1/jobs/del', { method: 'DELETE' });
  assert.equal(del.status, 202);
  await until(() => manager.get('del').state === 'cancelled');
  assert.equal((await call('/v1/jobs/del')).body.state, 'cancelled');
});

test('events stream replays, follows and ends at the final event; Last-Event-ID resumes', async () => {
  await call('/v1/jobs', { method: 'POST', body: fakeSpec('ev') });
  await until(() => fake.controls.has('ev'));
  const seen = [];
  const following = followJobEvents({ url: `${url}/v1/jobs/ev/events`, headers: { authorization: `Bearer ${TOKEN}` }, onEvent: e => seen.push(e) });
  await until(() => seen.length === 2);
  fake.controls.get('ev').rt.progress({ pct: 50, outTimeMs: 500 });
  fake.controls.get('ev').release({ exitCode: 0, outputs: [{ name: 'o', uri: 'file:///x', bytes: 1 }] });
  const final = await following;
  assert.deepEqual(seen.map(e => e.state), ['queued', 'running', 'running', 'succeeded']);
  assert.equal(seen[2].progress.pct, 50);
  assert.equal(final.outputs[0].bytes, 1);
  assert.deepEqual(seen.map(e => e.seq), [1, 2, 3, 4]);

  // Resume after seq 2: only later events, then the stream closes by itself.
  const res = await fetch(`${url}/v1/jobs/ev/events`, { headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': '2' } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const resumed = [];
  await readSse(res.body, m => resumed.push(Number(m.id)));
  assert.deepEqual(resumed, [3, 4]);
});

test('stdin to a job without stdin is 409', async () => {
  await call('/v1/jobs', { method: 'POST', body: fakeSpec('nostdin') });
  const r = await call('/v1/jobs/nostdin/stdin', { method: 'POST', raw: 'abc' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'NO_STDIN');
  await call('/v1/jobs/nostdin', { method: 'DELETE' });
});

test('503 answers carry retry-after', async () => {
  const m = new JobManager({ executors: { fake: fakeExecutor().executor } });
  await m.close();
  const { server: s, url: u } = await listen(createApiHandler({ backend: { submit: x => m.submit(x) } }));
  try {
    const res = await fetch(`${u}/v1/jobs`, { method: 'POST', body: JSON.stringify(fakeSpec('x')), headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 503);
    assert.ok(res.headers.get('retry-after'));
  } finally {
    await close(s);
  }
});

test('followJobEvents gives up on 4xx and on a server that keeps closing', async () => {
  await assert.rejects(followJobEvents({ url: `${url}/v1/jobs/missing/events`, headers: { authorization: `Bearer ${TOKEN}` }, onEvent() {} }), { status: 404 });
  const { server: s, url: u } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(': nothing\n\n');
  });
  try {
    await assert.rejects(followJobEvents({ url: u, onEvent() {}, maxRetries: 2, retryDelayMs: 1 }), /keeps closing/);
  } finally {
    await close(s);
  }
});
