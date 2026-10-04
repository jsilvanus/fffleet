// The orchestrator's config file (YAML or JSON): where new workers may be started and how.

import { readFileSync } from 'node:fs';
import { KINDS, normalizeKinds, normalizeSlots } from 'fffleet';
import { parseYaml } from './yaml.js';

export const PROVIDERS = ['process', 'docker', 'hetzner'];
const DEFAULT_WORKER_IMAGE = 'ghcr.io/jsilvanus/fffleet-worker:latest';

const TOP_KEYS = ['publicUrl', 'autoscale', 'pools'];
const AUTOSCALE_KEYS = ['id', 'interval', 'scaleUpAfter', 'idleAfter', 'bootTimeout', 'maxWorkers', 'joinSecret'];
const POOL_KEYS = ['name', 'provider', 'min', 'max', 'kinds', 'slots', 'slotsHint', 'capabilities', 'env', 'maxConcurrentCreates', 'idleAfter', 'process', 'docker', 'hetzner'];
const PROVIDER_KEYS = {
  process: ['command', 'cwd'],
  docker: ['image', 'network', 'socket', 'port', 'cpus', 'memory', 'pull'],
  hetzner: ['token', 'serverType', 'location', 'image', 'workerImage', 'sshKeys', 'network', 'firewalls', 'advertise', 'port', 'registry', 'alignToBillingHour', 'baseUrl', 'extraRunArgs'],
};

/** "5s", "10m", "1h", "250ms" or a number of milliseconds. */
export function parseDuration(value, where) {
  if (typeof value === 'number' && value >= 0) return value;
  const m = typeof value === 'string' ? value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/) : null;
  if (!m) throw new Error(`${where}: "${value}" is not a duration (use for example 500ms, 10s, 5m, 1h)`);
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]);
}

/** Replaces ${NAME} with environment variables (an unset one is an error), anywhere in the document. */
export function interpolateEnv(value, env = process.env, where = 'config') {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new Error(`${where}: environment variable ${name} is not set`);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateEnv(v, env, `${where}[${i}]`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env, `${where}.${k}`)]));
  return value;
}

function onlyKeys(obj, allowed, where) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${where} must be a mapping`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`${where}: unknown setting "${k}" (known: ${allowed.join(', ')})`);
  }
}

/**
 * Checks a parsed config and fills in defaults. Throws an Error that names the offending setting.
 * @returns {{ publicUrl: string | null, autoscale: object, pools: object[] }}
 */
export function normalizeConfig(raw, env = process.env) {
  const doc = interpolateEnv(raw ?? {}, env);
  onlyKeys(doc, TOP_KEYS, 'config');
  const as = doc.autoscale ?? {};
  onlyKeys(as, AUTOSCALE_KEYS, 'autoscale');

  const autoscale = {
    id: String(as.id ?? 'default'),
    interval: parseDuration(as.interval ?? '5s', 'autoscale.interval'),
    scaleUpAfter: parseDuration(as.scaleUpAfter ?? '10s', 'autoscale.scaleUpAfter'),
    idleAfter: parseDuration(as.idleAfter ?? '5m', 'autoscale.idleAfter'),
    bootTimeout: parseDuration(as.bootTimeout ?? '5m', 'autoscale.bootTimeout'),
    maxWorkers: as.maxWorkers === undefined ? Infinity : Number(as.maxWorkers),
    joinSecret: as.joinSecret ? String(as.joinSecret) : null,
  };
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(autoscale.id)) throw new Error('autoscale.id may use letters, digits, ".", "_" and "-" (40 characters at most)');
  if (autoscale.interval < 100) throw new Error('autoscale.interval must be at least 100ms');
  if (!(autoscale.maxWorkers >= 1)) throw new Error('autoscale.maxWorkers must be at least 1');

  if (!Array.isArray(doc.pools) || !doc.pools.length) throw new Error('pools must list at least one pool');
  const names = new Set();
  const pools = doc.pools.map((p, i) => {
    const where = `pools[${i}]`;
    onlyKeys(p, POOL_KEYS, where);
    if (typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(p.name)) throw new Error(`${where}.name must be lowercase letters, digits and "-" (for example "batch-cloud")`);
    if (names.has(p.name)) throw new Error(`${where}.name "${p.name}" is used twice`);
    names.add(p.name);
    if (!PROVIDERS.includes(p.provider)) throw new Error(`${where}.provider must be one of ${PROVIDERS.join(', ')}`);

    const min = p.min === undefined ? 0 : Number(p.min);
    const max = p.max === undefined ? Math.max(min, 1) : Number(p.max);
    if (!Number.isInteger(min) || min < 0) throw new Error(`${where}.min must be a whole number, 0 or more`);
    if (!Number.isInteger(max) || max < min) throw new Error(`${where}.max must be a whole number, not below min (0 retires a pool: its workers are removed when idle)`);

    let kinds;
    try {
      kinds = normalizeKinds(p.kinds);
    } catch (err) {
      throw new Error(`${where}.kinds: ${err.message}`);
    }
    const slotsSpec = p.slots ?? 'auto';
    let slots;
    try {
      slots = normalizeSlots(typeof slotsSpec === 'object' ? slotsSpec : String(slotsSpec), { kinds, cpus: 4 });
    } catch (err) {
      throw new Error(`${where}.slots: ${err.message}`);
    }
    const slotsText = typeof slotsSpec === 'object' ? Object.entries(slotsSpec).map(([k, v]) => `${k}=${v}`).join(',') : String(slotsSpec);
    const isAuto = typeof slotsSpec === 'string' && slotsSpec.trim().startsWith('auto');

    const provider = p[p.provider] ?? {};
    onlyKeys(provider, PROVIDER_KEYS[p.provider], `${where}.${p.provider}`);
    const wrongBlock = PROVIDERS.find(other => other !== p.provider && p[other] !== undefined);
    if (wrongBlock) throw new Error(`${where}: has a "${wrongBlock}" block but its provider is ${p.provider}`);
    if (p.provider === 'hetzner') {
      for (const required of ['token', 'serverType']) if (!provider[required]) throw new Error(`${where}.hetzner.${required} is required`);
    }
    if (p.provider === 'docker' && !provider.network) throw new Error(`${where}.docker.network is required (the Docker network the orchestrator and the workers share)`);

    const capabilities = (p.capabilities ?? []).map(String);
    const poolEnv = Object.fromEntries(Object.entries(p.env ?? {}).map(([k, v]) => [k, String(v)]));
    if (poolEnv.AWS_ACCESS_KEY_ID && poolEnv.AWS_SECRET_ACCESS_KEY && !capabilities.includes('scheme:s3')) capabilities.push('scheme:s3');

    return {
      name: p.name,
      provider: p.provider,
      min,
      max,
      kinds,
      slots: slotsText,
      slotsResolved: slots,
      slotsAuto: isAuto,
      slotsHint: p.slotsHint === undefined ? null : Number(p.slotsHint),
      capabilities,
      env: poolEnv,
      maxConcurrentCreates: Number(p.maxConcurrentCreates ?? 2),
      idleAfter: p.idleAfter === undefined ? null : parseDuration(p.idleAfter, `${where}.idleAfter`),
      options: { workerImage: DEFAULT_WORKER_IMAGE, ...provider },
    };
  });

  const publicUrl = doc.publicUrl ? String(doc.publicUrl).replace(/\/+$/, '') : null;
  if (!publicUrl && pools.some(p => p.provider !== 'process')) throw new Error('publicUrl is required when a pool uses the docker or hetzner provider (the address new workers use to reach this orchestrator)');
  return { publicUrl, autoscale, pools };
}

/** Reads and checks a config file; `.json` is parsed as JSON, anything else as YAML. */
export function loadConfig(path, env = process.env) {
  const text = readFileSync(path, 'utf8');
  let raw;
  try {
    raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
  try {
    return normalizeConfig(raw, env);
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}

export { KINDS };
