// Hetzner Cloud servers as workers. Talks to the Cloud API (https://docs.hetzner.cloud) with fetch.

const API = 'https://api.hetzner.cloud/v1';
const HOUR = 3600000;

/**
 * One provider per hetzner pool, so each pool keeps its own token, server type and labels.
 *
 * @param {object} opts
 * @param {object} opts.pool                  The normalized pool (see normalizeConfig).
 * @param {typeof fetch} [opts.fetch]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.retryDelayMs]        First delay when the API answers 429 or 5xx (doubles each try).
 */
export function createHetznerProvider({ pool, fetch: f = globalThis.fetch, log = () => {}, retryDelayMs = 1000 }) {
  const o = pool.options;
  const base = (o.baseUrl ?? API).replace(/\/+$/, '');

  async function api(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${o.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || retryDelayMs * 2 ** attempt;
        log(`hetzner: ${method} ${path} answered ${res.status}; retrying in ${Math.round(wait / 100) / 10}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const e = new Error(`Hetzner ${method} ${path} failed: HTTP ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`.trim());
        e.status = res.status;
        throw e;
      }
      return json;
    }
  }

  return {
    name: 'hetzner',
    // Hetzner bills by the hour, so an idle server is kept until shortly before its hour is up.
    billing: o.alignToBillingHour === false ? null : { alignMs: HOUR, windowMs: 5 * 60000 },

    /** Servers of this pool that belong to the given orchestrator. */
    async list(orchestratorId) {
      const out = [];
      for (let page = 1; page; ) {
        const q = new URLSearchParams({ label_selector: `fffleet.orchestrator=${orchestratorId},fffleet.pool=${pool.name}`, per_page: '50', page: String(page) });
        const res = await api('GET', `/servers?${q}`);
        for (const s of res.servers ?? []) {
          out.push({ providerId: String(s.id), workerId: s.labels?.['fffleet.worker'], pool: pool.name, createdAt: Date.parse(s.created) || Date.now() });
        }
        page = res.meta?.pagination?.next_page ?? 0;
      }
      return out.filter(s => s.workerId);
    },

    async create({ workerId, env, labels }) {
      const body = {
        name: `fffleet-${workerId}`,
        server_type: o.serverType,
        image: o.image ?? 'docker-ce',
        ...(o.location ? { location: o.location } : {}),
        ...(o.sshKeys?.length ? { ssh_keys: o.sshKeys } : {}),
        ...(o.network ? { networks: [Number(o.network)] } : {}),
        ...(o.firewalls?.length ? { firewalls: o.firewalls.map(id => ({ firewall: Number(id) })) } : {}),
        labels,
        user_data: cloudInit({ env, options: o }),
        start_after_create: true,
        automount: false,
      };
      const res = await api('POST', '/servers', body);
      return { providerId: String(res.server.id) };
    },

    async destroy(providerId) {
      try {
        await api('DELETE', `/servers/${providerId}`);
      } catch (err) {
        if (err.status !== 404) throw err; // already gone
      }
    },
  };
}

/**
 * The cloud-init document a new server runs: it writes the worker's settings to a file readable only
 * by root, works out its own address, and starts the worker image with Docker.
 */
export function cloudInit({ env, options }) {
  const port = Number(options.port ?? 5100);
  const advertise = options.advertise ?? 'public';
  const image = options.workerImage;
  const metadata = 'http://169.254.169.254/hetzner/v1/metadata';
  const addressCmd = advertise === 'private'
    ? `curl -s --retry 10 --retry-connrefused ${metadata}/private-networks | grep -m1 -oE 'ip: [0-9.]+' | cut -d' ' -f2`
    : `curl -s --retry 10 --retry-connrefused ${metadata}/public-ipv4`;
  const envFile = Object.entries({ ...env, PORT: String(port), HOST: '0.0.0.0' }).map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new Error(`environment variable ${k} cannot contain a line break`);
    return `${k}=${v}`;
  });
  const login = options.registry
    ? [`echo '${shellQuote(options.registry.password)}' | docker login ${options.registry.server ?? 'ghcr.io'} -u '${shellQuote(options.registry.username)}' --password-stdin`]
    : [];
  const lines = [
    '#cloud-config',
    'write_files:',
    '  - path: /etc/fffleet/worker.env',
    "    permissions: '0600'",
    '    content: |',
    ...envFile.map(l => `      ${l}`),
    'runcmd:',
    `  - [ sh, -c, ${JSON.stringify(`IP=$(${addressCmd}); echo "FFFLEET_ADVERTISE_URL=http://$IP:${port}" >> /etc/fffleet/worker.env`)} ]`,
    ...login.map(c => `  - [ sh, -c, ${JSON.stringify(c)} ]`),
    `  - [ sh, -c, ${JSON.stringify(`docker run -d --name fffleet-worker --restart unless-stopped --env-file /etc/fffleet/worker.env -p ${port}:${port} ${(options.extraRunArgs ?? []).join(' ')} ${image}`.replace(/\s+/g, ' '))} ]`,
  ];
  return `${lines.join('\n')}\n`;
}

const shellQuote = s => String(s).replace(/'/g, "'\\''");
