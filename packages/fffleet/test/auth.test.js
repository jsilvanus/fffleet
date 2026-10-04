import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createAuthenticator, createClientStore, createTokenProvider, createTokenSigner, createTokenVerifier, generateSecret, hashSecret, issueToken, principal, verifySecret } from '../src/auth.js';

const keys = () => generateKeyPairSync('ed25519');
const req = authorization => ({ headers: authorization ? { authorization } : {} });

test('secrets hash and verify; a wrong secret or an unknown hash fails', async () => {
  const secret = generateSecret();
  const hash = await hashSecret(secret);
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifySecret(secret, hash), true);
  assert.equal(await verifySecret(`${secret}x`, hash), false);
  assert.equal(await verifySecret(secret, undefined), false);
  assert.equal(await verifySecret(secret, 'plain$text'), false);
  assert.notEqual(await hashSecret(secret), hash, 'each hash has its own salt');
});

test('a signed token verifies; tampering, another key, expiry and a wrong issuer do not', async () => {
  const { privateKey } = keys();
  const signer = createTokenSigner({ privateKey, ttlSeconds: 60 });
  const verify = createTokenVerifier({ getKey: kid => (kid === signer.kid ? signer.publicKey : null) });
  const token = signer.sign({ sub: 'app', scope: ['jobs', 'metrics'] });
  const claims = await verify(token);
  assert.equal(claims.sub, 'app');
  assert.deepEqual(claims.scope, ['jobs', 'metrics']);

  const [h, p, s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), scope: 'admin' })).toString('base64url');
  assert.equal(await verify(`${h}.${forged}.${s}`), null);
  assert.equal(await verify(`${h}.${p}`), null);
  assert.equal(await verify('not a token'), null);

  const other = createTokenSigner({ privateKey: keys().privateKey });
  assert.equal(await verify(other.sign({ sub: 'x', scope: ['admin'] })), null, 'unknown key id');
  const impostor = createTokenSigner({ privateKey: keys().privateKey });
  const sameKid = createTokenVerifier({ getKey: () => signer.publicKey });
  assert.equal(await sameKid(impostor.sign({ sub: 'x', scope: ['admin'] })), null, 'wrong signature');

  const expired = createTokenSigner({ privateKey, ttlSeconds: -120 });
  assert.equal(await verify(expired.sign({ sub: 'app', scope: ['jobs'] })), null);
  const foreign = createTokenSigner({ privateKey, issuer: 'someone-else' });
  assert.equal(await verify(foreign.sign({ sub: 'app', scope: ['jobs'] })), null);
});

test('the client store rejects bad entries and unknown scopes', () => {
  assert.throws(() => createClientStore([{ id: 'a' }]), /secretHash/);
  assert.throws(() => createClientStore([{ id: 'a', secretHash: 'x', scopes: ['root'] }]), /unknown scope/);
  const store = createClientStore([{ id: 'a', secretHash: 'x' }]);
  assert.deepEqual(store.get('a').scopes, ['jobs']);
  assert.equal(store.get('b'), null);
});

test('issueToken: client credentials from Basic or the body, scope narrowing, errors', async () => {
  const signer = createTokenSigner({ privateKey: keys().privateKey });
  const secret = generateSecret();
  const clients = createClientStore([{ id: 'app 1', secretHash: await hashSecret(secret), scopes: ['jobs', 'metrics'] }]);
  const basic = `Basic ${Buffer.from(`${encodeURIComponent('app 1')}:${encodeURIComponent(secret)}`).toString('base64')}`;
  const grant = { grant_type: 'client_credentials' };

  const ok = await issueToken({ req: req(basic), body: grant, clients, signer });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.token_type, 'Bearer');
  assert.equal(ok.body.scope, 'jobs metrics');
  assert.equal(ok.headers['cache-control'], 'no-store');

  const form = await issueToken({ req: req(), body: new URLSearchParams({ ...grant, client_id: 'app 1', client_secret: secret, scope: 'jobs' }), clients, signer });
  assert.equal(form.status, 200);
  assert.equal(form.body.scope, 'jobs');

  assert.equal((await issueToken({ req: req(), body: { ...grant, client_id: 'app 1', client_secret: secret, scope: 'admin' }, clients, signer })).body.error, 'invalid_scope');
  const wrong = await issueToken({ req: req(), body: { ...grant, client_id: 'app 1', client_secret: 'nope' }, clients, signer });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'invalid_client');
  assert.equal((await issueToken({ req: req(), body: { ...grant, client_id: 'ghost', client_secret: secret }, clients, signer })).status, 401);
  assert.equal((await issueToken({ req: req(), body: { grant_type: 'password' }, clients, signer })).body.error, 'unsupported_grant_type');
  assert.equal((await issueToken({ req: req('Basic !!!'), body: grant, clients, signer })).status, 401);
});

test('the authenticator: open, static token, signed token, removed client', async () => {
  assert.equal((await createAuthenticator({})(req())).admin, true, 'no credentials configured means open');

  const signer = createTokenSigner({ privateKey: keys().privateKey });
  const verify = createTokenVerifier({ getKey: kid => (kid === signer.kid ? signer.publicKey : null) });
  let active = true;
  const auth = createAuthenticator({ token: 'static', verify, isActive: () => active });
  assert.equal(await auth(req()), null);
  assert.equal(await auth(req('Bearer wrong')), null);
  assert.equal((await auth(req('Bearer static'))).admin, true);

  const who = await auth(req(`Bearer ${signer.sign({ sub: 'app', scope: ['jobs', 'bogus'] })}`));
  assert.equal(who.sub, 'app');
  assert.deepEqual([...who.scopes], ['jobs'], 'unknown scopes are dropped');
  assert.equal(who.admin, false);
  active = false;
  assert.equal(await auth(req(`Bearer ${signer.sign({ sub: 'app', scope: ['jobs'] })}`)), null, 'a removed client loses its tokens');
  assert.deepEqual([...principal('x', ['admin']).scopes].sort(), ['admin', 'jobs', 'metrics']);
});

test('the token provider logs in once, reuses the token and refreshes on demand', async () => {
  let calls = 0;
  const f = async (url, init) => {
    calls++;
    assert.equal(url, 'http://orch/v1/auth/token');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('client_id'), 'app');
    assert.equal(body.get('scope'), 'jobs');
    return new Response(JSON.stringify({ access_token: `t${calls}`, expires_in: 3600 }), { status: 200 });
  };
  const provider = createTokenProvider({ url: 'http://orch/', clientId: 'app', clientSecret: 's', scope: 'jobs', fetch: f });
  assert.equal(await provider.get(), 't1');
  assert.equal(await provider.get(), 't1');
  assert.equal(await provider.get({ refresh: true }), 't2');
  const [a, b] = await Promise.all([provider.get({ refresh: true }), provider.get({ refresh: true })]);
  assert.equal(a, b, 'concurrent refreshes share one login');

  const denied = createTokenProvider({ url: 'http://orch', clientId: 'app', clientSecret: 'bad', fetch: async () => new Response('{"error":"invalid_client","error_description":"nope"}', { status: 401 }) });
  await assert.rejects(denied.get(), err => err.code === 'UNAUTHORIZED' && /nope/.test(err.message));
});
