// Two apps share one orchestrator through logins, and a Prometheus-style scraper finds and reads
// the fleet's metrics, all with the real bin scripts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createFleet } from 'fffleet';
import { ORCHESTRATOR_BIN, WORKER_BIN, api, averageColor, isGreen, isRed, startBin, tempDir, waitFor } from '../helpers/index.js';

const exec = promisify(execFile);
const WORKER_TOKEN = 'worker-secret';
let tmp, orchestrator, worker, clientsFile;
const secrets = {};

/** Runs `fffleet-orchestrator add-client` and returns the secret it printed. */
async function addClient(id, scope) {
  const { stdout } = await exec(process.execPath, [ORCHESTRATOR_BIN, 'add-client', id, '--scope', scope, '--file', clientsFile]);
  return stdout.match(/client secret \(shown once\): (\S+)/)[1];
}

before(async () => {
  tmp = await tempDir();
  clientsFile = join(tmp.dir, 'clients.json');
  secrets['app-red'] = await addClient('app-red', 'jobs');
  secrets['app-green'] = await addClient('app-green', 'jobs');
  secrets.prometheus = await addClient('prometheus', 'metrics');
  orchestrator = await startBin(ORCHESTRATOR_BIN, {
    FFFLEET_CLIENTS_FILE: clientsFile,
    FFFLEET_SIGNING_KEY_FILE: join(tmp.dir, 'signing.pem'),
    FFFLEET_WORKER_TOKEN: WORKER_TOKEN,
    FFFLEET_HEARTBEAT_TIMEOUT_MS: '3000',
  });
  worker = await startBin(WORKER_BIN, {
    FFFLEET_WORKER_ID: 'w1',
    FFFLEET_ORCHESTRATOR_URL: orchestrator.url,
    FFFLEET_WORKER_TOKEN: WORKER_TOKEN,
    FFFLEET_HEARTBEAT_MS: '300',
    FFFLEET_WORK_DIR: join(tmp.dir, 'work'),
    FFFLEET_SLOTS: 'default=2',
  });
  await waitFor(async () => (await api(`${orchestrator.url}/v1/sd/prometheus`, { token: await login('prometheus') })).body?.length === 1, { message: 'the worker to register' });
});

after(async () => {
  await worker?.stop('SIGKILL');
  await orchestrator?.stop();
  await tmp?.cleanup();
});

async function login(id, scope) {
  const res = await fetch(`${orchestrator.url}/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secrets[id], ...(scope ? { scope } : {}) }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).access_token;
}

const colorJob = (color, name) => ({
  kind: 'batch',
  outputs: [{ name: 'img', uri: pathToFileURL(join(tmp.dir, `${name}.png`)).href }],
  ffmpeg: { args: ['-f', 'lavfi', '-i', `color=c=${color}:s=64x48:d=0.2`, '-frames:v', '1', '{{output:img}}'], durationMs: 200 },
});

test('add-client stores only a hash, with the scopes asked for', async () => {
  const file = JSON.parse(await readFile(clientsFile, 'utf8'));
  assert.deepEqual(file.clients.map(c => [c.id, c.scopes]), [['app-red', ['jobs']], ['app-green', ['jobs']], ['prometheus', ['metrics']]]);
  for (const c of file.clients) {
    assert.match(c.secretHash, /^scrypt\$/);
    assert.ok(!JSON.stringify(c).includes(secrets[c.id]));
  }
});

test('two apps log in to one orchestrator and each sees only its own jobs', async () => {
  const red = createFleet({ url: orchestrator.url, clientId: 'app-red', clientSecret: secrets['app-red'], fallback: 'none' });
  const green = createFleet({ url: orchestrator.url, clientId: 'app-green', clientSecret: secrets['app-green'], fallback: 'none' });
  try {
    const [r, g] = await Promise.all([red.submit(colorJob('0xFF0000', 'red')), green.submit(colorJob('0x00FF00', 'green'))]);
    const [rd, gd] = await Promise.all([r.done, g.done]);
    assert.equal(rd.state, 'succeeded', JSON.stringify(rd.error));
    assert.equal(gd.state, 'succeeded', JSON.stringify(gd.error));
    assert.equal(rd.owner, 'app-red');
    assert.equal(gd.owner, 'app-green');
    assert.ok(isRed(await averageColor(join(tmp.dir, 'red.png'))));
    assert.ok(isGreen(await averageColor(join(tmp.dir, 'green.png'))));

    const t = await login('app-red');
    const list = await api(`${orchestrator.url}/v1/jobs`, { token: t });
    assert.deepEqual(list.body.jobs.map(j => j.owner), ['app-red']);
    assert.equal((await api(`${orchestrator.url}/v1/jobs/${gd.id}`, { token: t })).status, 404);
    assert.equal((await api(`${orchestrator.url}/v1/workers`, { token: t })).status, 403);
  } finally {
    await red.close();
    await green.close();
  }
});

test('Prometheus-style scrape: service discovery, then the orchestrator and the worker with one token', async () => {
  const token = await login('prometheus');
  const sd = await api(`${orchestrator.url}/v1/sd/prometheus`, { token });
  assert.equal(sd.status, 200);
  assert.equal(sd.body.length, 1);
  const [target] = sd.body;
  assert.equal(target.labels.fffleet_worker, 'w1');

  const orch = await (await fetch(`${orchestrator.url}/metrics`, { headers: { authorization: `Bearer ${token}` } })).text();
  assert.match(orch, /fffleet_workers 1\n/);
  assert.match(orch, /fffleet_jobs_finished_total\{owner="app-red",class="default",kind="batch",state="succeeded",code=""\} 1\n/);
  assert.match(orch, /fffleet_jobs_finished_total\{owner="app-green",class="default",kind="batch",state="succeeded",code=""\} 1\n/);
  assert.match(orch, /fffleet_auth_tokens_issued_total\{client="app-red"\} \d/);

  // The scraper reaches the worker at the address service discovery gave, with the same token.
  const scrape = await fetch(`${target.labels.__scheme__}://${target.targets[0]}${target.labels.__metrics_path__}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(scrape.status, 200);
  const text = await scrape.text();
  assert.match(text, /fffleet_slots\{pool="default"\} 2\n/);
  assert.match(text, /fffleet_jobs_finished_total\{owner="app-red",class="default",kind="batch",state="succeeded",code=""\} 1\n/);
  assert.match(text, /fffleet_build_info\{role="worker",version="[^"]+",worker="w1"\} 1\n/);
});

test('a metrics token cannot run jobs and an app token cannot read metrics', async () => {
  const metricsToken = await login('prometheus');
  assert.equal((await api(`${orchestrator.url}/v1/jobs`, { token: metricsToken })).status, 403);
  const appToken = await login('app-red');
  assert.equal((await fetch(`${orchestrator.url}/metrics`, { headers: { authorization: `Bearer ${appToken}` } })).status, 403);
  assert.equal((await fetch(`${orchestrator.url}/metrics`)).status, 401);
});
