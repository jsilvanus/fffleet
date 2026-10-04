// Docker containers as workers, through the Docker Engine API (a unix socket or tcp://host:port).

import { request } from 'node:http';

/**
 * Starts each worker as a container on a Docker network that the orchestrator shares, and reaches it
 * there by container name.
 *
 * @param {object} opts
 * @param {object} opts.pool                  The normalized pool.
 * @param {(msg: string) => void} [opts.log]
 * @param {(opts: { socketPath?: string, host?: string, port?: number, method: string, path: string, body?: object }) => Promise<{ status: number, body: any }>} [opts.call]  For tests.
 */
export function createDockerProvider({ pool, log = () => {}, call = engineCall }) {
  const o = pool.options;
  const target = dockerTarget(o.socket ?? process.env.DOCKER_HOST);
  const image = o.image ?? o.workerImage;
  const port = Number(o.port ?? 5100);
  const api = (method, path, body) => call({ ...target, method, path, body });
  const encodeId = id => encodeURIComponent(id);

  async function pull() {
    const [name, tag = 'latest'] = splitImage(image);
    log(`docker: pulling ${image}`);
    const res = await api('POST', `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`);
    if (res.status >= 300) throw new Error(`could not pull ${image}: HTTP ${res.status} ${errorText(res.body)}`);
  }

  return {
    name: 'docker',
    billing: null,

    async list(orchestratorId) {
      const filters = JSON.stringify({ label: [`fffleet.orchestrator=${orchestratorId}`, `fffleet.pool=${pool.name}`] });
      const res = await api('GET', `/containers/json?all=true&filters=${encodeURIComponent(filters)}`);
      if (res.status !== 200) throw new Error(`docker list failed: HTTP ${res.status} ${errorText(res.body)}`);
      return res.body
        .filter(c => c.Labels?.['fffleet.worker'])
        .map(c => ({ providerId: c.Id, workerId: c.Labels['fffleet.worker'], pool: pool.name, createdAt: (c.Created ?? 0) * 1000 }));
    },

    async create({ workerId, env, labels }) {
      const body = {
        Image: image,
        Env: Object.entries({ ...env, PORT: String(port), HOST: '0.0.0.0', FFFLEET_ADVERTISE_URL: `http://${workerId}:${port}` }).map(([k, v]) => `${k}=${v}`),
        Labels: labels,
        ExposedPorts: { [`${port}/tcp`]: {} },
        HostConfig: {
          NetworkMode: o.network,
          RestartPolicy: { Name: 'no' },
          ...(o.cpus ? { NanoCpus: Math.round(Number(o.cpus) * 1e9) } : {}),
          ...(o.memory ? { Memory: Number(o.memory) } : {}),
        },
      };
      let res = await api('POST', `/containers/create?name=${encodeURIComponent(workerId)}`, body);
      if (res.status === 404 && o.pull !== false) {
        await pull();
        res = await api('POST', `/containers/create?name=${encodeURIComponent(workerId)}`, body);
      }
      if (res.status !== 201) throw new Error(`docker create failed: HTTP ${res.status} ${errorText(res.body)}`);
      const id = res.body.Id;
      const started = await api('POST', `/containers/${encodeId(id)}/start`);
      if (started.status >= 300 && started.status !== 304) {
        await api('DELETE', `/containers/${encodeId(id)}?force=true`).catch(() => {});
        throw new Error(`docker start failed: HTTP ${started.status} ${errorText(started.body)}`);
      }
      return { providerId: id };
    },

    async destroy(providerId) {
      const res = await api('DELETE', `/containers/${encodeId(providerId)}?force=true&v=true`);
      if (res.status >= 300 && res.status !== 404) throw new Error(`docker remove failed: HTTP ${res.status} ${errorText(res.body)}`);
    },
  };
}

const errorText = body => (typeof body === 'string' ? body : body?.message ?? '').slice(0, 200);

function splitImage(image) {
  const at = image.lastIndexOf(':');
  return at > image.lastIndexOf('/') ? [image.slice(0, at), image.slice(at + 1)] : [image, 'latest'];
}

/** A unix socket path, "unix:///path", or "tcp://host:port". */
export function dockerTarget(spec) {
  if (!spec) return { socketPath: '/var/run/docker.sock' };
  if (spec.startsWith('tcp://') || spec.startsWith('http://')) {
    const u = new URL(spec.replace(/^tcp:/, 'http:'));
    return { host: u.hostname, port: Number(u.port || 2375) };
  }
  return { socketPath: spec.replace(/^unix:\/\//, '') };
}

function engineCall({ socketPath, host, port, method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(
      { socketPath, host, port, method, path, headers: { host: 'docker', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // image pulls stream several JSON documents; the text is enough
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('docker request timed out')));
    req.once('error', reject);
    req.end(payload);
  });
}
