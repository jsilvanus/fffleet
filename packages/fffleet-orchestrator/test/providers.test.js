import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { createHetznerProvider, cloudInit } from '../src/providers/hetzner.js';
import { createDockerProvider, dockerTarget } from '../src/providers/docker.js';

const poolOf = (provider, block, extra = {}) => normalizeConfig({ publicUrl: 'http://orch:5000', pools: [{ name: 'p', provider, [provider]: block, ...extra }] }, {}).pools[0];

/** A fake Hetzner Cloud API: servers with labels, pagination, and optional 429s. */
async function fakeHetzner() {
  const servers = [];
  const seen = [];
  let nextId = 100;
  let throttle = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body });
      const send = (status, json, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(json));
      };
      if (throttle > 0) {
        throttle--;
        return send(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }, { 'retry-after': '0' });
      }
      if (req.method === 'POST' && url.pathname === '/servers') {
        const s = { id: nextId++, labels: body.labels, created: new Date().toISOString() };
        servers.push(s);
        return send(201, { server: s });
      }
      if (req.method === 'GET' && url.pathname === '/servers') {
        const sel = Object.fromEntries(url.searchParams.get('label_selector').split(',').map(p => p.split('=')));
        const hits = servers.filter(s => Object.entries(sel).every(([k, v]) => s.labels[k] === v));
        const page = Number(url.searchParams.get('page'));
        const slice = hits.slice((page - 1) * 1, page * 1); // one per page, to exercise paging
        return send(200, { servers: slice, meta: { pagination: { next_page: page * 1 < hits.length ? page + 1 : null } } });
      }
      const m = url.pathname.match(/^\/servers\/(\d+)$/);
      if (req.method === 'DELETE' && m) {
        const i = servers.findIndex(s => String(s.id) === m[1]);
        if (i < 0) return send(404, { error: { code: 'not_found', message: 'gone' } });
        servers.splice(i, 1);
        return send(200, {});
      }
      send(404, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    servers, seen,
    throttle: n => { throttle = n; },
    close: () => new Promise(r => server.close(r)),
  };
}

test('hetzner: create, list by label (paged), destroy, and a missing server is fine', async () => {
  const api = await fakeHetzner();
  try {
    const pool = poolOf('hetzner', { token: 'secret', serverType: 'cpx31', location: 'hel1', sshKeys: ['key'], baseUrl: api.url });
    const h = createHetznerProvider({ pool, retryDelayMs: 1 });
    const labels = (w) => ({ 'fffleet.orchestrator': 'default', 'fffleet.pool': 'p', 'fffleet.worker': w });
    const a = await h.create({ workerId: 'p-aaaaaa', env: { FFFLEET_TOKEN: 't' }, labels: labels('p-aaaaaa') });
    await h.create({ workerId: 'p-bbbbbb', env: { FFFLEET_TOKEN: 't' }, labels: labels('p-bbbbbb') });
    await h.create({ workerId: 'other', env: {}, labels: { ...labels('other'), 'fffleet.pool': 'elsewhere' } });
    const post = api.seen.find(r => r.method === 'POST');
    assert.equal(post.auth, 'Bearer secret');
    assert.equal(post.body.server_type, 'cpx31');
    assert.equal(post.body.location, 'hel1');
    assert.deepEqual(post.body.ssh_keys, ['key']);
    assert.match(post.body.user_data, /FFFLEET_TOKEN=t/);
    const found = await h.list('default');
    assert.deepEqual(found.map(f => f.workerId).sort(), ['p-aaaaaa', 'p-bbbbbb']);
    await h.destroy(a.providerId);
    await h.destroy(a.providerId); // 404 is not an error
    assert.equal((await h.list('default')).length, 1);
    assert.deepEqual(h.billing, { alignMs: 3600000, windowMs: 300000 });
  } finally {
    await api.close();
  }
});

test('hetzner: 429 is retried; other errors carry the API message', async () => {
  const api = await fakeHetzner();
  try {
    const h = createHetznerProvider({ pool: poolOf('hetzner', { token: 't', serverType: 'x', baseUrl: api.url }), retryDelayMs: 1 });
    api.throttle(2);
    await h.create({ workerId: 'w', env: {}, labels: { 'fffleet.worker': 'w' } });
    assert.equal(api.servers.length, 1);
    const stub = createHetznerProvider({
      pool: poolOf('hetzner', { token: 't', serverType: 'x' }),
      fetch: async () => new Response(JSON.stringify({ error: { code: 'resource_unavailable', message: 'no capacity' } }), { status: 412 }),
    });
    await assert.rejects(stub.create({ workerId: 'w', env: {}, labels: {} }), /412 resource_unavailable no capacity/);
  } finally {
    await api.close();
  }
});

test('hetzner: billing alignment can be switched off', () => {
  assert.equal(createHetznerProvider({ pool: poolOf('hetzner', { token: 't', serverType: 'x', alignToBillingHour: false }) }).billing, null);
});

test('cloud-init: settings in a root-only file, address from metadata, worker image started', () => {
  const doc = cloudInit({ env: { FFFLEET_TOKEN: 'abc', FFFLEET_SLOTS: 'auto' }, options: { workerImage: 'ghcr.io/x/w:1', port: 5100 } });
  assert.match(doc, /^#cloud-config/);
  assert.match(doc, /permissions: '0600'/);
  assert.match(doc, /FFFLEET_TOKEN=abc/);
  assert.match(doc, /public-ipv4/);
  assert.match(doc, /docker run -d --name fffleet-worker .* ghcr\.io\/x\/w:1/);
  assert.match(cloudInit({ env: {}, options: { workerImage: 'i', advertise: 'private' } }), /private-networks/);
  const login = cloudInit({ env: {}, options: { workerImage: 'i', registry: { username: 'u', password: "p'w" } } });
  assert.match(login, /docker login ghcr\.io/);
  assert.throws(() => cloudInit({ env: { A: 'x\ny' }, options: { workerImage: 'i' } }), /line break/);
});

/** A fake Docker engine behind the provider's `call` hook. */
function fakeEngine({ missingImage = false } = {}) {
  const calls = [];
  const containers = [];
  let pulled = !missingImage;
  const call = async ({ method, path, body }) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path.startsWith('/containers/create')) {
      if (!pulled) return { status: 404, body: { message: 'No such image' } };
      const c = { Id: `c${containers.length + 1}`, Labels: body.Labels, Created: 1700000000 };
      containers.push(c);
      return { status: 201, body: { Id: c.Id } };
    }
    if (method === 'POST' && path.startsWith('/images/create')) {
      pulled = true;
      return { status: 200, body: '' };
    }
    if (method === 'POST' && path.endsWith('/start')) return { status: 204, body: null };
    if (method === 'GET' && path.startsWith('/containers/json')) return { status: 200, body: containers };
    if (method === 'DELETE') {
      const id = decodeURIComponent(path.split('/')[2].split('?')[0]);
      const i = containers.findIndex(c => c.Id === id);
      if (i < 0) return { status: 404, body: { message: 'no such container' } };
      containers.splice(i, 1);
      return { status: 204, body: null };
    }
    return { status: 500, body: 'unexpected' };
  };
  return { call, calls, containers };
}

test('docker: create (pulling a missing image), list by label, destroy', async () => {
  const eng = fakeEngine({ missingImage: true });
  const pool = poolOf('docker', { network: 'media', cpus: 2, memory: 1000000, image: 'ghcr.io/x/w:2' });
  const d = createDockerProvider({ pool, call: eng.call });
  const labels = { 'fffleet.orchestrator': 'default', 'fffleet.pool': 'p', 'fffleet.worker': 'p-111111' };
  const { providerId } = await d.create({ workerId: 'p-111111', env: { FFFLEET_TOKEN: 't' }, labels });
  assert.equal(providerId, 'c1');
  const create = eng.calls.filter(c => c.path.startsWith('/containers/create'));
  assert.equal(create.length, 2, 'retried after the pull');
  assert.ok(eng.calls.some(c => c.path.startsWith('/images/create?fromImage=ghcr.io%2Fx%2Fw&tag=2')));
  assert.equal(create[1].body.HostConfig.NetworkMode, 'media');
  assert.equal(create[1].body.HostConfig.NanoCpus, 2e9);
  assert.ok(create[1].body.Env.includes('FFFLEET_ADVERTISE_URL=http://p-111111:5100'));
  assert.deepEqual((await d.list('default')).map(f => f.workerId), ['p-111111']);
  await d.destroy('c1');
  await d.destroy('c1'); // already gone
  assert.deepEqual(await d.list('default'), []);
});

test('docker: engine errors surface', async () => {
  const d = createDockerProvider({ pool: poolOf('docker', { network: 'n' }), call: async () => ({ status: 500, body: { message: 'boom' } }) });
  await assert.rejects(d.create({ workerId: 'w', env: {}, labels: {} }), /docker create failed: HTTP 500 boom/);
});

test('docker targets', () => {
  assert.deepEqual(dockerTarget(undefined), { socketPath: '/var/run/docker.sock' });
  assert.deepEqual(dockerTarget('unix:///run/d.sock'), { socketPath: '/run/d.sock' });
  assert.deepEqual(dockerTarget('tcp://dock:2376'), { host: 'dock', port: 2376 });
});
