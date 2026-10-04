// SigV4 against the worked examples in the Amazon S3 documentation
// ("Signature Calculations for the Authorization Header", examplebucket, 20130524).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signV4 } from '../src/index.js';

const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const base = { host: 'examplebucket.s3.amazonaws.com', 'x-amz-date': '20130524T000000Z', 'x-amz-content-sha256': EMPTY };
const sig = auth => auth.match(/Signature=([0-9a-f]+)/)[1];

test('GET object with a Range header', () => {
  const auth = signV4({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { ...base, range: 'bytes=0-9' }, payloadHash: EMPTY }, creds);
  assert.equal(sig(auth), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, /);
});

test('GET bucket lifecycle (a query parameter without a value)', () => {
  const auth = signV4({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'), headers: base, payloadHash: EMPTY }, creds);
  assert.equal(sig(auth), 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
});

test('GET bucket listing (sorted query parameters)', () => {
  const auth = signV4({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'), headers: base, payloadHash: EMPTY }, creds);
  assert.equal(sig(auth), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});
