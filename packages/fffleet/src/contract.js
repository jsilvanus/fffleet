// Job contract v1: the spec a client submits and the states a job moves through.
// The same rules are applied by the local runner, the worker and the orchestrator.

export const CONTRACT_VERSION = 1;

export const KINDS = Object.freeze(['stream', 'batch']);

export const STATES = Object.freeze([
  'queued', 'assigned', 'staging', 'running', 'uploading', 'succeeded', 'failed', 'cancelled',
]);

const FINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** @param {string} state */
export function isFinal(state) {
  return FINAL.has(state);
}

/** Schemes a worker can stage or write itself. */
export const FILE_SCHEMES = Object.freeze(['file:']);
/** Fetched before a batch job starts, uploaded (HTTP PUT) after it ends; passed through for streams. */
export const HTTP_SCHEMES = Object.freeze(['http:', 'https:']);
/** Handed to ffmpeg as they are (live sources and destinations). */
export const PASSTHROUGH_SCHEMES = Object.freeze(['rtmp:', 'rtmps:', 'srt:', 'udp:', 'tcp:', 'rtsp:', 'rtp:']);
/**
 * Object storage, staged by a worker that holds the credentials (batch jobs only).
 * s3://bucket/key is one object; s3://bucket/prefix/ (trailing slash) is an output folder.
 */
export const OBJECT_SCHEMES = Object.freeze(['s3:']);

const ALL_SCHEMES = new Set([...FILE_SCHEMES, ...HTTP_SCHEMES, ...PASSTHROUGH_SCHEMES, ...OBJECT_SCHEMES]);

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLASS_RE = /^[a-z0-9_-]{1,32}$/;
const PLACEHOLDER_RE = /\{\{(input|output):([^}]*)\}\}/g;

export class ContractError extends Error {
  /** @param {{ path: string, message: string }[]} errors */
  constructor(errors) {
    super(`invalid job spec: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'ContractError';
    this.code = 'INVALID_SPEC';
    this.status = 422;
    this.errors = errors;
  }
}

/**
 * Validates a job spec and returns it with defaults filled in.
 * Unknown top-level fields are dropped so idempotency checks compare like with like.
 *
 * @param {unknown} input
 * @returns {{ ok: true, spec: import('./types.js').JobSpec } | { ok: false, errors: { path: string, message: string }[] }}
 */
export function validateSpec(input) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ path: '', message: 'spec must be an object' }] };
  }
  const s = /** @type {Record<string, any>} */ (input);

  const contract = s.contract ?? CONTRACT_VERSION;
  if (contract !== CONTRACT_VERSION) err('contract', `unsupported contract version ${contract}; this build speaks ${CONTRACT_VERSION}`);

  if (s.id !== undefined && (typeof s.id !== 'string' || !ID_RE.test(s.id))) {
    err('id', 'must be 1-128 characters of A-Z a-z 0-9 . _ : -');
  }
  if (!KINDS.includes(s.kind)) err('kind', `must be one of ${KINDS.join(', ')}`);

  const type = s.type ?? 'ffmpeg';
  if (typeof type !== 'string' || !NAME_RE.test(type)) err('type', 'must be a short name such as "ffmpeg"');

  const cls = s.class ?? 'default';
  if (typeof cls !== 'string' || !CLASS_RE.test(cls)) err('class', 'must be 1-32 characters of a-z 0-9 _ -');

  const priority = s.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) err('priority', 'must be an integer from -1000 to 1000');

  const owner = s.owner ?? '';
  if (typeof owner !== 'string' || owner.length > 256) err('owner', 'must be a string of at most 256 characters');

  const timeoutMs = s.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) err('timeoutMs', 'must be a positive integer');

  const stdin = s.stdin ?? false;
  if (typeof stdin !== 'boolean') err('stdin', 'must be a boolean');

  const requires = s.requires ?? [];
  if (!Array.isArray(requires) || requires.some(r => typeof r !== 'string' || !r)) err('requires', 'must be an array of capability strings');

  const labels = s.labels ?? {};
  if (typeof labels !== 'object' || Array.isArray(labels) || Object.values(labels).some(v => typeof v !== 'string')) {
    err('labels', 'must be an object of string values');
  }

  const inputs = normalizeEndpoints(s.inputs, 'inputs', err);
  const outputs = normalizeEndpoints(s.outputs, 'outputs', err);
  checkObjectEndpoints(s.kind, inputs, outputs, err);

  let ffmpeg;
  if (type === 'ffmpeg') {
    const f = s.ffmpeg;
    if (!f || typeof f !== 'object' || !Array.isArray(f.args) || f.args.length === 0 || f.args.some(a => typeof a !== 'string')) {
      err('ffmpeg.args', 'must be a non-empty array of strings');
    } else {
      const durationMs = f.durationMs ?? null;
      if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0)) err('ffmpeg.durationMs', 'must be a positive number');
      ffmpeg = { args: [...f.args], durationMs };
      checkPlaceholders(f.args, inputs, outputs, err);
    }
  }

  if (errors.length) return { ok: false, errors };

  /** @type {any} */
  const spec = {
    contract,
    id: s.id,
    kind: s.kind,
    type,
    class: cls,
    priority,
    owner,
    requires: [...new Set(requires)].sort(),
    labels: { ...labels },
    timeoutMs,
    stdin,
    inputs,
    outputs,
  };
  if (ffmpeg) spec.ffmpeg = ffmpeg;
  else if (s[type] !== undefined) spec[type] = s[type];
  return { ok: true, spec };
}

/** Like validateSpec but throws a ContractError. */
export function parseSpec(input) {
  const r = validateSpec(input);
  if (!r.ok) throw new ContractError(r.errors);
  return r.spec;
}

function normalizeEndpoints(list, path, err) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    err(path, 'must be an array');
    return [];
  }
  const seen = new Set();
  return list.map((e, i) => {
    const p = `${path}[${i}]`;
    if (!e || typeof e !== 'object') {
      err(p, 'must be an object');
      return {};
    }
    if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) err(`${p}.name`, 'must be 1-64 characters of A-Z a-z 0-9 _ -');
    else if (seen.has(e.name)) err(`${p}.name`, `duplicate name "${e.name}"`);
    seen.add(e.name);
    let url;
    try {
      url = new URL(e.uri);
    } catch {
      err(`${p}.uri`, 'must be an absolute URI');
    }
    if (url && !ALL_SCHEMES.has(url.protocol)) err(`${p}.uri`, `scheme ${url.protocol} is not supported`);
    const out = { name: e.name, uri: e.uri };
    if (e.contentType !== undefined) {
      if (typeof e.contentType !== 'string') err(`${p}.contentType`, 'must be a string');
      else out.contentType = e.contentType;
    }
    return out;
  });
}

function checkObjectEndpoints(kind, inputs, outputs, err) {
  const check = (list, path, isOutput) => list.forEach((e, i) => {
    let url;
    try {
      url = new URL(e.uri);
    } catch {
      return;
    }
    if (url.protocol !== 's3:') return;
    const p = `${path}[${i}].uri`;
    if (kind === 'stream') err(p, 's3: is only supported for batch jobs');
    if (!url.hostname) err(p, 's3: URIs need a bucket: s3://bucket/key');
    const key = url.pathname.replace(/^\//, '');
    const rootFolder = isOutput && url.pathname === '/';
    if (!key && !rootFolder) err(p, 's3: URIs need a key: s3://bucket/key');
    else if (key.endsWith('/') && !isOutput) err(p, 'an input must name one object, not a folder');
  });
  check(inputs, 'inputs', false);
  check(outputs, 'outputs', true);
}

/**
 * Capabilities a job needs beyond its `requires`: `type:<type>`, plus `scheme:s3` when it uses s3: URIs.
 * @param {{ type: string, inputs: { uri: string }[], outputs: { uri: string }[] }} spec
 */
export function implicitRequirements(spec) {
  const reqs = [`type:${spec.type}`];
  const schemes = new Set([...spec.inputs, ...spec.outputs].map(e => {
    try {
      return new URL(e.uri).protocol;
    } catch {
      return null;
    }
  }));
  for (const scheme of OBJECT_SCHEMES) if (schemes.has(scheme)) reqs.push(`scheme:${scheme.slice(0, -1)}`);
  return reqs;
}

function checkPlaceholders(args, inputs, outputs, err) {
  const names = { input: new Set(inputs.map(i => i.name)), output: new Set(outputs.map(o => o.name)) };
  args.forEach((arg, i) => {
    for (const m of arg.matchAll(PLACEHOLDER_RE)) {
      if (!names[m[1]].has(m[2])) err(`ffmpeg.args[${i}]`, `${m[0]} names no ${m[1]}`);
    }
  });
}

/**
 * Replaces {{input:name}} and {{output:name}} in every argument.
 * @param {string[]} args
 * @param {{ input: Record<string, string>, output: Record<string, string> }} values
 */
export function resolvePlaceholders(args, values) {
  return args.map(arg => arg.replace(PLACEHOLDER_RE, (whole, kind, name) => {
    const v = values[kind][name];
    if (v === undefined) throw new Error(`unresolved placeholder ${whole}`);
    return v;
  }));
}

/** JSON with sorted keys, used to compare two specs for idempotent submission. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
