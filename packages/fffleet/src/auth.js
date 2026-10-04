// App login: OAuth2 client credentials, short-lived Ed25519-signed JWTs, scopes. No dependencies.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, scrypt, sign, timingSafeEqual, verify } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { FleetError } from './job-record.js';

const scryptAsync = promisify(scrypt);

/** `jobs`: submit and see your own jobs. `metrics`: /metrics and service discovery. `admin`: everything, all owners. */
export const SCOPES = ['jobs', 'metrics', 'admin'];
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const LEEWAY_S = 30;

const b64url = buf => Buffer.from(buf).toString('base64url');

/** Hashes a client secret for the clients file: `scrypt$N$r$p$salt$hash`. */
export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64url(salt), b64url(hash)].join('$');
}

// Compared against when the client id is unknown, so a wrong id costs as long as a wrong secret.
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(Buffer.alloc(16))}$${b64url(Buffer.alloc(32))}`;

/** Checks a secret against a `hashSecret` value in constant time. */
export async function verifySecret(secret, stored) {
  const parts = String(stored ?? DUMMY_HASH).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64url');
  let got;
  try {
    got = await scryptAsync(String(secret), Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * Number(N) * Number(r) });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A random client secret (256 bits, base64url). */
export function generateSecret() {
  return b64url(randomBytes(32));
}

/**
 * Loads the Ed25519 signing key from `path`, creating it (mode 0600) when the file does not exist.
 * Without a path the key is generated in memory: tokens then stop working when the process restarts.
 */
export function loadSigningKey(path) {
  if (path && existsSync(path)) return createPrivateKey(readFileSync(path));
  const { privateKey } = generateKeyPairSync('ed25519');
  if (path) writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return privateKey;
}

function keyId(publicKey) {
  return createHash('sha256').update(publicKey.export({ format: 'jwk' }).x).digest('base64url').slice(0, 16);
}

/**
 * Issues tokens.
 * @param {object} opts
 * @param {import('node:crypto').KeyObject | string} opts.privateKey   Ed25519 private key (KeyObject or PEM).
 * @param {string} [opts.issuer]
 * @param {number} [opts.ttlSeconds]
 */
export function createTokenSigner({ privateKey, issuer = 'fffleet', ttlSeconds = 3600 }) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const publicKey = createPublicKey(key);
  const kid = keyId(publicKey);
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
  return {
    kid,
    issuer,
    ttlSeconds,
    /** @param {{ sub: string, scope: string[] }} claims */
    sign({ sub, scope }) {
      const iat = Math.floor(Date.now() / 1000);
      const payload = b64url(JSON.stringify({ iss: issuer, sub, scope: scope.join(' '), iat, exp: iat + ttlSeconds, jti: randomUUID() }));
      const signature = sign(null, Buffer.from(`${header}.${payload}`), key);
      return `${header}.${payload}.${b64url(signature)}`;
    },
    /** The public key as a JWK Set, for GET /v1/auth/keys. */
    jwks() {
      return { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] };
    },
    publicKey,
  };
}

/**
 * Verifies tokens. `getKey(kid)` returns a public KeyObject or null.
 * @returns {(token: string) => Promise<{ sub: string, scope: string[], exp: number } | null>}
 */
export function createTokenVerifier({ getKey, issuer = 'fffleet' }) {
  return async token => {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (header?.alg !== 'EdDSA' || typeof header.kid !== 'string') return null;
    const key = await getKey(header.kid);
    if (!key) return null;
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return null;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer || typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < now) return null;
    return { sub: claims.sub, scope: String(claims.scope ?? '').split(' ').filter(Boolean), exp: claims.exp };
  };
}

/**
 * Fetches public keys from a JWK Set URL (an orchestrator's /v1/auth/keys) and caches them.
 * An unknown key id triggers a refetch at most every `minRefreshMs`.
 */
export function createRemoteKeySet(url, { fetch: f = globalThis.fetch, minRefreshMs = 30000 } = {}) {
  let keys = new Map();
  let fetchedAt = 0;
  let pending = null;
  async function refresh() {
    fetchedAt = Date.now();
    const res = await f(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`key set returned HTTP ${res.status}`);
    const body = await res.json();
    keys = new Map((body.keys ?? []).filter(k => k.kty === 'OKP' && k.crv === 'Ed25519').map(k => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
  }
  return async kid => {
    if (!keys.has(kid) && Date.now() - fetchedAt >= minRefreshMs) {
      pending ??= refresh().catch(() => {}).finally(() => (pending = null));
      await pending;
    }
    return keys.get(kid) ?? null;
  };
}

/**
 * Who a request is from. `scopes` decide what it may do; `admin` sees and controls every owner's jobs.
 * @typedef {{ sub: string, scopes: Set<string>, admin: boolean }} Principal
 */

/** @returns {Principal} */
export function principal(sub, scopes) {
  const set = new Set(scopes);
  if (set.has('admin')) for (const s of SCOPES) set.add(s);
  return { sub, scopes: set, admin: set.has('admin') };
}

/** The principal used when no authentication is configured: everything is allowed. */
export const OPEN = principal('anonymous', ['admin']);

export function bearerOf(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Builds an authenticator: a function from a request to a Principal, or null when the request
 * carries no valid credentials.
 * @param {object} opts
 * @param {string | null} [opts.token]        A static token that is granted `admin`.
 * @param {((token: string) => Promise<{ sub: string, scope: string[] } | null>) | null} [opts.verify]
 * @param {(sub: string) => boolean} [opts.isActive]   Rejects tokens of clients that were removed.
 * @param {boolean} [opts.open]               Without any credentials configured, allow everything.
 */
export function createAuthenticator({ token = null, verify: verifyToken = null, isActive = () => true, open = !token && !verifyToken }) {
  return async req => {
    if (open) return OPEN;
    const given = bearerOf(req);
    if (!given) return null;
    if (token && sameSecret(given, token)) return principal('admin', ['admin']);
    if (!verifyToken || given.split('.').length !== 3) return null;
    const claims = await verifyToken(given);
    if (!claims || !isActive(claims.sub)) return null;
    return principal(claims.sub, claims.scope.filter(s => SCOPES.includes(s)));
  };
}

/**
 * Reads the clients file, reloading it when it changes on disk.
 * Format: { "clients": [{ "id": "app", "secretHash": "scrypt$...", "scopes": ["jobs"] }] }
 */
export function createClientStore(source) {
  if (!source) return null;
  if (typeof source !== 'string') return staticStore(source);
  let mtime = -1;
  let checkedAt = 0;
  let store = staticStore([]);
  const reload = () => {
    if (Date.now() - checkedAt < 1000) return store;
    checkedAt = Date.now();
    const m = statSync(source).mtimeMs;
    if (m !== mtime) {
      store = staticStore(JSON.parse(readFileSync(source, 'utf8')).clients ?? []);
      mtime = m;
    }
    return store;
  };
  reload();
  return { get: id => reload().get(id), has: id => reload().has(id), get size() { return reload().size; } };
}

function staticStore(list) {
  const map = new Map();
  for (const c of list) {
    if (!c || typeof c.id !== 'string' || !c.id || typeof c.secretHash !== 'string') throw new Error('each client needs id and secretHash');
    const scopes = Array.isArray(c.scopes) && c.scopes.length ? c.scopes : ['jobs'];
    for (const s of scopes) if (!SCOPES.includes(s)) throw new Error(`client ${c.id}: unknown scope "${s}"`);
    map.set(c.id, { id: c.id, secretHash: c.secretHash, scopes });
  }
  return { get: id => map.get(id) ?? null, has: id => map.has(id), get size() { return map.size; } };
}

/**
 * The OAuth2 token endpoint (client credentials grant, RFC 6749 4.4).
 * Reads client_id/client_secret from HTTP Basic or the form body; `scope` may narrow the grant.
 * @returns {Promise<{ status: number, body: object, headers?: Record<string, string> }>}
 */
export async function issueToken({ req, body, clients, signer }) {
  const params = body instanceof URLSearchParams ? Object.fromEntries(body) : (body ?? {});
  let id = params.client_id;
  let secret = params.client_secret;
  let basic = false;
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    basic = true;
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = raw.indexOf(':');
    try {
      id = decodeURIComponent(raw.slice(0, colon).replace(/\+/g, ' '));
      secret = decodeURIComponent(raw.slice(colon + 1).replace(/\+/g, ' '));
    } catch {
      return oauthError(400, 'invalid_request', 'malformed Basic credentials');
    }
  }
  if (params.grant_type !== 'client_credentials') return oauthError(400, 'unsupported_grant_type', 'only client_credentials is supported');
  if (!id || !secret) return oauthError(401, 'invalid_client', 'client_id and client_secret are required', basic);
  const client = clients?.get(id) ?? null;
  const ok = await verifySecret(secret, client?.secretHash);
  if (!client || !ok) return oauthError(401, 'invalid_client', 'unknown client or wrong secret', basic);
  const requested = String(params.scope ?? '').split(/\s+/).filter(Boolean);
  const scope = requested.length ? requested : client.scopes;
  // `admin` implies every scope, so an admin app can ask for a narrower token.
  const allowedScopes = principal(id, client.scopes).scopes;
  if (!scope.every(s => allowedScopes.has(s))) return oauthError(400, 'invalid_scope', `client ${id} may request: ${[...allowedScopes].join(' ')}`);
  return {
    status: 200,
    headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
    body: { access_token: signer.sign({ sub: id, scope }), token_type: 'Bearer', expires_in: signer.ttlSeconds, scope: scope.join(' ') },
  };
}

function oauthError(status, error, description, basic = false) {
  return {
    status,
    headers: { 'cache-control': 'no-store', ...(status === 401 && basic ? { 'www-authenticate': 'Basic realm="fffleet"' } : {}) },
    body: { error, error_description: description },
  };
}

/**
 * Client side: gets tokens from an orchestrator and refreshes them before they expire.
 * @returns {{ get: (opts?: { refresh?: boolean }) => Promise<string> }}
 */
export function createTokenProvider({ url, clientId, clientSecret, scope, fetch: f = globalThis.fetch, timeoutMs = 10000 }) {
  let token = null;
  let expiresAt = 0;
  let pending = null;
  async function fetchToken() {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, ...(scope ? { scope } : {}) });
    const res = await f(`${url.replace(/\/+$/, '')}/v1/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) {
      throw new FleetError(res.status === 401 ? 'UNAUTHORIZED' : 'LOGIN_FAILED', `login as ${clientId} failed: ${json?.error_description ?? json?.error ?? `HTTP ${res.status}`}`, { status: res.status });
    }
    token = json.access_token;
    // Refresh when 80% of the lifetime has passed.
    expiresAt = Date.now() + (json.expires_in ?? 3600) * 800;
    return token;
  }
  return {
    async get({ refresh = false } = {}) {
      if (!refresh && token && Date.now() < expiresAt) return token;
      pending ??= fetchToken().finally(() => (pending = null));
      return pending;
    },
  };
}
