import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { FleetError } from './job-record.js';

const JSON_LIMIT = 1024 * 1024;
const STDIN_LIMIT = 1024 * 1024;
const SSE_KEEPALIVE_MS = 15000;

/**
 * @typedef {object} JobBackend
 * Anything that runs jobs: the local JobManager (worker) or the orchestrator.
 * @property {(spec: any) => { created: boolean, job: any } | Promise<{ created: boolean, job: any }>} submit
 * @property {(id: string) => any} get
 * @property {() => any[]} list
 * @property {(id: string) => any | Promise<any>} cancel
 * @property {(id: string, data: Buffer) => Promise<any>} writeStdin
 * @property {(id: string, afterSeq: number, fn: (e: any) => void) => () => void} subscribe
 * @property {() => any} capabilities
 */

/**
 * The consumer API (contract v1), served identically by a worker and the orchestrator.
 *
 * @param {object} opts
 * @param {JobBackend} opts.backend
 * @param {string | null} [opts.token]      Bearer token required on every route except /v1/health.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<boolean> | boolean} [opts.extraRoutes]
 */
export function createApiHandler({ backend, token = null, extraRoutes }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true });
      if (extraRoutes && (await extraRoutes(req, res, url))) return;
      if (!checkBearer(req, token)) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'missing or wrong bearer token' } });

      if (url.pathname === '/v1/capabilities' && req.method === 'GET') return send(res, 200, await backend.capabilities());
      if (url.pathname === '/v1/jobs') {
        if (req.method === 'POST') {
          const { created, queued, job } = await backend.submit(await readJson(req));
          // 201: took a slot (or was handed to a worker) now; 202: waiting in the queue; 200: already known.
          return send(res, created ? ((queued ?? job.state === 'queued') ? 202 : 201) : 200, job);
        }
        if (req.method === 'GET') return send(res, 200, { jobs: backend.list() });
      }

      const m = url.pathname.match(/^\/v1\/jobs\/([^/]+)(\/events|\/stdin)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!m[2] && req.method === 'GET') {
          const job = backend.get(id);
          return job ? send(res, 200, job) : notFound(res, id);
        }
        if (!m[2] && req.method === 'DELETE') {
          const job = await backend.cancel(id);
          return job ? send(res, 202, job) : notFound(res, id);
        }
        if (m[2] === '/events' && req.method === 'GET') return streamEvents(req, res, url, backend, id);
        if (m[2] === '/stdin' && req.method === 'POST') {
          const data = await readBody(req, STDIN_LIMIT);
          return send(res, 200, { ok: true, ...(await backend.writeStdin(id, data)) });
        }
      }
      return send(res, 404, { error: { code: 'NOT_FOUND', message: `no route ${req.method} ${url.pathname}` } });
    } catch (err) {
      return sendError(res, err);
    }
  };
}

/** Starts an HTTP server on host:port (port 0 picks a free port). */
export function listen(handler, { port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      resolve({ server, port: addr.port, url: `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${addr.port}` });
    });
  });
}

/** Closes a server, ending open event streams. */
export function close(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function streamEvents(req, res, url, backend, id) {
  if (!backend.get(id)) return notFound(res, id);
  const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': fffleet events\n\n');
  let unsubscribe = null;
  let ended = false;
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), SSE_KEEPALIVE_MS);
  keepalive.unref?.();
  const finish = () => {
    ended = true;
    clearInterval(keepalive);
    unsubscribe?.();
  };
  req.on('close', finish);
  unsubscribe = backend.subscribe(id, after, event => {
    res.write(`id: ${event.seq}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`);
    if (['succeeded', 'failed', 'cancelled'].includes(event.state)) {
      finish();
      res.end();
    }
  });
  // A job that was already final ended the stream during the replay above.
  if (ended) unsubscribe();
}

export function checkBearer(req, token) {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const body = { error: { code: err?.code ?? 'INTERNAL', message: err?.message ?? 'internal error' } };
  if (err?.errors) body.error.details = err.errors;
  return send(res, status, body, status === 503 ? { 'retry-after': '5' } : {});
}

function notFound(res, id) {
  return send(res, 404, { error: { code: 'NOT_FOUND', message: `job ${id} not found` } });
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new FleetError('TOO_LARGE', `request body over ${limit} bytes`, { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const raw = await readBody(req, JSON_LIMIT);
  try {
    return JSON.parse(raw.toString('utf8') || 'null');
  } catch {
    throw new FleetError('BAD_JSON', 'request body is not valid JSON', { status: 400 });
  }
}
