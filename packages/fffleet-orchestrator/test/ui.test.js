import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/orchestrator.js';

const TOKEN = 'admin-token';
let o;

before(async () => {
  o = createOrchestrator({ port: 0, host: '127.0.0.1', token: TOKEN, sweepMs: 50 });
  await o.start();
});
after(() => o.stop());

test('serves the dashboard at /ui/ without a token', async () => {
  const res = await fetch(`${o.url}/ui/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /fffleet orchestrator/);
});

test('/ui redirects to /ui/', async () => {
  const res = await fetch(`${o.url}/ui`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/ui/');
});

test('serves the script and stylesheet with their types', async () => {
  const js = await fetch(`${o.url}/ui/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const css = await fetch(`${o.url}/ui/style.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('refuses paths outside the ui directory and unknown types', async () => {
  // Encoded, so fetch does not normalise the dots away: the server must catch it.
  for (const path of ['/ui/..%2Fsrc%2Forchestrator.js', '/ui/missing.html', '/ui/app.mjs']) {
    const res = await fetch(`${o.url}${path}`);
    assert.equal(res.status, 404, path);
  }
  // Plain ../ is normalised by fetch to /src/..., which is not under /ui and is not served either.
  const plain = await fetch(`${o.url}/ui/../src/orchestrator.js`);
  assert.notEqual(plain.status, 200);
});

test('the data stays behind the token', async () => {
  assert.equal((await fetch(`${o.url}/v1/workers`)).status, 401);
  assert.equal((await fetch(`${o.url}/v1/jobs`)).status, 401);
  const ok = await fetch(`${o.url}/v1/workers`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
});

test('ui: false turns the dashboard off', async () => {
  const off = createOrchestrator({ port: 0, host: '127.0.0.1', token: TOKEN, ui: false });
  await off.start();
  try {
    // Without the UI the path is an ordinary API route: it needs a token and is never the page.
    const res = await fetch(`${off.url}/ui/`);
    assert.notEqual(res.status, 200);
  } finally {
    await off.stop();
  }
});
