// The fffleet orchestrator dashboard. Logs in with a client (client credentials), then polls the
// job API once a second. The token lives in sessionStorage: it ends with the tab and the log-out button.

const POLL_MS = 1000;
const KEY = 'fffleet-ui-token';
const $ = id => document.getElementById(id);

let token = readToken();
let timer = null;

function readToken() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writeToken(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Private windows can refuse storage; the page then keeps the token in memory only.
  }
}

/** Shows the login form or the dashboard. */
function show(view) {
  $('login').hidden = view !== 'login';
  $('dashboard').hidden = view !== 'dashboard';
  $('logout').hidden = view !== 'dashboard';
}

async function login(form) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: form.get('client_id'),
    client_secret: form.get('client_secret'),
  });
  const res = await fetch('/v1/auth/token', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(json.error_description ?? `login failed (HTTP ${res.status})`);
  writeToken(json.access_token);
}

function logout(message = '') {
  clearTimeout(timer);
  timer = null;
  writeToken(null);
  $('login-error').textContent = message;
  show('login');
}

/** GET with the token. Returns null when the token is no longer accepted. */
async function get(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) return null;
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const sum = (obj = {}) => Object.values(obj).reduce((a, b) => a + b, 0);

/** The totals the dashboard shows, computed from the registered workers. */
function summarise(workers) {
  const hosts = new Set(workers.map(w => safeHost(w.url)));
  const kinds = {};
  const pools = {};
  let slots = 0;
  let used = 0;
  for (const w of workers) {
    const total = sum(w.slots);
    const busy = sum(w.used);
    slots += total;
    used += busy;
    for (const kind of w.kinds ?? []) {
      kinds[kind] ??= { workers: 0, slots: 0, used: 0 };
      kinds[kind].workers += 1;
      kinds[kind].slots += total;
      kinds[kind].used += busy;
    }
    for (const [pool, n] of Object.entries(w.slots ?? {})) {
      pools[pool] ??= { workers: 0, slots: 0 };
      pools[pool].workers += 1;
      pools[pool].slots += n;
    }
  }
  return { nodes: hosts.size, workers: workers.length, slots, used, kinds, pools };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url ?? '?';
  }
}

function cell(text, cls = '') {
  const td = document.createElement('td');
  td.textContent = text ?? '';
  if (cls) td.className = cls;
  return td;
}

function row(...cells) {
  const tr = document.createElement('tr');
  tr.append(...cells);
  return tr;
}

function render(workers, jobs) {
  const s = summarise(workers);
  const running = jobs.filter(j => j.state === 'running' || j.state === 'assigned');
  const queued = jobs.filter(j => j.state === 'queued');

  $('s-nodes').textContent = s.nodes;
  $('s-workers').textContent = s.workers;
  $('s-slots').textContent = `${s.used} / ${s.slots}`;
  $('s-running').textContent = running.length;
  $('s-queued').textContent = queued.length;

  const kindRows = Object.entries(s.kinds).sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, v]) => row(cell(kind), cell(v.workers), cell(v.slots), cell(v.used)));
  $('kinds').replaceChildren(...(kindRows.length ? kindRows : [row(cell('no workers registered', 'muted'))]));
  $('pools').textContent = Object.keys(s.pools).length
    ? `Pools: ${Object.entries(s.pools).map(([name, v]) => `${name} (${v.slots} slots on ${v.workers} ${v.workers === 1 ? 'worker' : 'workers'})`).join(', ')}`
    : '';

  const jobRows = running.map(j => row(
    cell(j.id),
    cell(j.kind),
    cell(j.type),
    cell(j.class),
    cell(j.workerId),
    cell(j.state),
    cell(typeof j.progress?.pct === 'number' ? `${Math.round(j.progress.pct)} %` : '–'),
  ));
  $('running').replaceChildren(...jobRows);
  $('empty').hidden = running.length > 0;
  $('updated').textContent = new Date().toLocaleTimeString();
}

async function poll() {
  try {
    const [workersBody, jobsBody] = await Promise.all([get('/v1/workers'), get('/v1/jobs')]);
    if (!workersBody || !jobsBody) return logout('Your session ended. Log in again.');
    $('notice').hidden = true;
    render(workersBody.workers ?? [], jobsBody.jobs ?? []);
  } catch (err) {
    $('notice').hidden = false;
    $('notice').textContent = err.status === 403
      ? 'This client may not read the worker list. Log in with a client that has the admin scope.'
      : `Could not reach the orchestrator (${err.message}). Retrying.`;
  }
  timer = setTimeout(poll, POLL_MS);
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-error').textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    await login(form);
    event.currentTarget.reset();
    enterDashboard();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', () => logout());

function enterDashboard() {
  show('dashboard');
  clearTimeout(timer);
  poll();
}

show(token ? 'dashboard' : 'login');
if (token) poll();
