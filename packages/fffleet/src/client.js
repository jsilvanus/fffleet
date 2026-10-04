import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isFinal, parseSpec } from './contract.js';
import { detectCapabilities } from './capabilities.js';
import { JobManager } from './job-manager.js';
import { FleetError } from './job-record.js';
import { createTokenProvider } from './auth.js';
import { followJobEvents } from './sse.js';

/**
 * A handle to one submitted job, local or remote.
 * Events: 'event' (every JobEvent), 'state' (state, event), 'progress' (progress, event).
 * `done` resolves with the final snapshot whatever the outcome; check `state`.
 */
export class JobHandle extends EventEmitter {
  constructor(id, where) {
    super();
    this.id = id;
    /** 'local' or 'remote' */
    this.where = where;
    this.state = 'queued';
    /** @type {import('./types.js').JobSnapshot | null} */
    this.snapshot = null;
    let resolve, reject;
    /** @type {Promise<import('./types.js').JobSnapshot>} */
    this.done = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.done.catch(() => {});
    this._resolve = resolve;
    this._reject = reject;
  }

  _event(event) {
    this.emit('event', event);
    if (event.progress) this.emit('progress', event.progress, event);
    if (event.state !== this.state) {
      this.state = event.state;
      this.emit('state', event.state, event);
    }
  }

  /** Cancels or stops the job. */
  cancel() {
    return this._cancel();
  }

  /** Writes to the job's stdin (spec.stdin must be true). */
  write(data) {
    return this._write(typeof data === 'string' ? Buffer.from(data) : data);
  }
}

/**
 * Creates a client. With no `url` every job runs on this machine. With a `url` (a worker or an
 * orchestrator, same API) jobs go there; if it cannot be reached and `fallback` is 'local',
 * the job runs here instead.
 *
 * @param {object} [opts]
 * @param {string} [opts.url]
 * @param {string} [opts.token]            A static bearer token.
 * @param {string} [opts.clientId]          With clientSecret: log in at the orchestrator (POST /v1/auth/token) instead of using a static token.
 * @param {string} [opts.clientSecret]
 * @param {string} [opts.scope]             Narrow the token to some of the client's scopes, e.g. 'jobs'.
 * @param {'local' | 'none'} [opts.fallback]
 * @param {ConstructorParameters<typeof JobManager>[0]} [opts.local]   Options for the local runner.
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.requestTimeoutMs]
 */
export function createFleet({ url, token, clientId, clientSecret, scope, fallback = 'local', local = {}, fetch: f = globalThis.fetch, requestTimeoutMs = 10000 } = {}) {
  const base = url ? url.replace(/\/+$/, '') : null;
  const login = base && clientId && clientSecret ? createTokenProvider({ url: base, clientId, clientSecret, scope, fetch: f, timeoutMs: requestTimeoutMs }) : null;
  const authHeaders = async (refresh = false) => {
    if (login) return { authorization: `Bearer ${await login.get({ refresh })}` };
    return token ? { authorization: `Bearer ${token}` } : {};
  };
  let manager = null;
  const localManager = () => (manager ??= new JobManager(local));
  const controllers = new Set();

  async function request(method, path, body, extraHeaders = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${base}${path}`, {
        method,
        headers: { ...(await authHeaders(attempt > 0)), ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      // An expired or revoked token: log in again once.
      if (res.status === 401 && login && attempt === 0) continue;
      if (!res.ok) {
        throw new FleetError(json?.error?.code ?? 'HTTP_ERROR', json?.error?.message ?? `HTTP ${res.status}`, { status: res.status, details: json?.error?.details });
      }
      return json;
    }
  }

  function submitLocal(spec) {
    const m = localManager();
    const { job } = m.submit(spec);
    const handle = new JobHandle(job.id, 'local');
    handle._cancel = async () => m.cancel(job.id);
    handle._write = data => m.writeStdin(job.id, data);
    m.subscribe(job.id, 0, event => {
      handle._event(event);
      if (isFinal(event.state)) {
        handle.snapshot = m.get(job.id);
        handle._resolve(handle.snapshot);
      }
    });
    return handle;
  }

  async function submitRemote(spec) {
    const job = await request('POST', '/v1/jobs', spec);
    const handle = new JobHandle(job.id, 'remote');
    handle.snapshot = job;
    const ac = new AbortController();
    controllers.add(ac);
    const enc = encodeURIComponent(job.id);
    handle._cancel = () => request('DELETE', `/v1/jobs/${enc}`);
    handle._write = data => request('POST', `/v1/jobs/${enc}/stdin`, data, { 'content-type': 'application/octet-stream' });
    followJobEvents({ url: `${base}/v1/jobs/${enc}/events`, headers: authHeaders, signal: ac.signal, fetch: f, onEvent: e => handle._event(e) })
      .then(async () => {
        handle.snapshot = await request('GET', `/v1/jobs/${enc}`).catch(() => handle.snapshot);
        handle._resolve(handle.snapshot);
      })
      .catch(err => handle._reject(err))
      .finally(() => controllers.delete(ac));
    return handle;
  }

  return {
    /** 'local' when no url is configured, else 'remote'. */
    mode: base ? 'remote' : 'local',

    /**
     * Submits a job and returns its handle.
     * @param {Partial<import('./types.js').JobSpec>} input
     * @returns {Promise<JobHandle>}
     */
    async submit(input) {
      const spec = parseSpec(input);
      // Choose the id here so a retry or a local fallback never runs the same job twice.
      spec.id ??= `job_${randomUUID()}`;
      if (!base) return submitLocal(spec);
      try {
        return await submitRemote(spec);
      } catch (err) {
        const unreachable = !(err instanceof FleetError) || err.status === 503 || err.status === 502;
        if (fallback === 'local' && unreachable) return submitLocal(spec);
        throw err;
      }
    },

    /** Capabilities of the remote side, or of this machine's runner in local mode. */
    async capabilities() {
      if (!base) return { slots: localManager().stats().pools, capabilities: await detectCapabilities(local.ffmpegPath) };
      return request('GET', '/v1/capabilities');
    },

    /** Stops following remote jobs and cancels local ones. */
    async close() {
      for (const ac of controllers) ac.abort();
      if (manager) await manager.close();
    },
  };
}
