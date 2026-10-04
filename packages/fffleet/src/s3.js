// A small S3 client (AWS Signature Version 4) for staging job inputs and outputs.
// Works with AWS S3 and S3-compatible stores (MinIO, Ceph, Garage, ...). No dependencies.

import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { pipeline } from 'node:stream/promises';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const UNSIGNED = 'UNSIGNED-PAYLOAD';
/** Files at or above this size are uploaded in parts. */
export const MULTIPART_THRESHOLD = 16 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip',
  '.ass': 'text/x-ssa',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/** A content type for a file name, by extension. */
export function contentTypeFor(name) {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Reads S3 settings from the environment. Returns null when no credentials are set.
 * AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION (or AWS_DEFAULT_REGION),
 * FFFLEET_S3_ENDPOINT (for S3-compatible stores), FFFLEET_S3_PATH_STYLE=1 (MinIO and most others).
 */
export function s3ConfigFromEnv(env = process.env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN || undefined,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
    endpoint: env.FFFLEET_S3_ENDPOINT || undefined,
    pathStyle: ['1', 'true', 'yes'].includes(String(env.FFFLEET_S3_PATH_STYLE ?? '').toLowerCase()),
  };
}

/** Splits s3://bucket/key into its parts. */
export function parseS3Uri(uri) {
  const url = new URL(uri);
  return { bucket: url.hostname, key: decodeURIComponent(url.pathname.replace(/^\//, '')) };
}

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
function rfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const encodeKey = key => key.split('/').map(rfc3986).join('/');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * Signs a request with AWS Signature Version 4. Exported for tests against AWS's published examples.
 *
 * @param {object} req
 * @param {string} req.method
 * @param {URL} req.url
 * @param {Record<string, string>} req.headers   Must include host and x-amz-date; every header given is signed.
 * @param {string} req.payloadHash
 * @param {{ accessKeyId: string, secretAccessKey: string, region: string }} creds
 * @param {string} [service]
 * @returns {string} the Authorization header value
 */
export function signV4({ method, url, headers, payloadHash }, creds, service = 's3') {
  const amzDate = headers['x-amz-date'];
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map(n => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // url.pathname is already percent-encoded the way we built it.
  const canonicalRequest = [method, url.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${creds.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, creds.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * @param {object} config
 * @param {string} config.accessKeyId
 * @param {string} config.secretAccessKey
 * @param {string} [config.sessionToken]
 * @param {string} [config.region]
 * @param {string} [config.endpoint]      e.g. http://minio:9000; defaults to AWS for the region.
 * @param {boolean} [config.pathStyle]    bucket in the path instead of the host name.
 * @param {typeof fetch} [config.fetch]
 * @param {number} [config.partSize]
 */
export function createS3Client(config) {
  const region = config.region ?? 'us-east-1';
  const endpoint = new URL(config.endpoint ?? `https://s3.${region}.amazonaws.com`);
  const pathStyle = config.pathStyle ?? !!config.endpoint;
  const doFetch = config.fetch ?? globalThis.fetch;
  const partSize = config.partSize ?? PART_SIZE;
  const creds = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region };

  function urlFor(bucket, key = '', query = {}) {
    const base = endpoint.pathname.replace(/\/+$/, '');
    const url = pathStyle
      ? new URL(`${endpoint.protocol}//${endpoint.host}${base}/${rfc3986(bucket)}/${encodeKey(key)}`)
      : new URL(`${endpoint.protocol}//${bucket}.${endpoint.host}${base}/${encodeKey(key)}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  /** The URL and signed headers of a request. */
  function sign(method, bucket, key, { query, headers = {} } = {}) {
    const url = urlFor(bucket, key, query);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const signed = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': UNSIGNED,
      ...(config.sessionToken ? { 'x-amz-security-token': config.sessionToken } : {}),
    };
    const authorization = signV4({ method, url, headers: signed, payloadHash: UNSIGNED }, creds);
    const { host, ...sendHeaders } = signed;
    return { url, headers: { ...sendHeaders, ...headers, authorization } };
  }

  function failure(method, bucket, key, status, text) {
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    const message = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
    const err = new Error(`S3 ${method} s3://${bucket}/${key} failed: HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`);
    err.status = status;
    err.s3Code = code;
    return err;
  }

  async function request(method, bucket, key, { query, headers = {}, body, signal } = {}) {
    const { url, headers: signedHeaders } = sign(method, bucket, key, { query, headers });
    const res = await doFetch(url, { method, headers: signedHeaders, body, signal, ...(body ? { duplex: 'half' } : {}) });
    if (!res.ok) throw failure(method, bucket, key, res.status, await res.text().catch(() => ''));
    return res;
  }

  /**
   * Streams an object to a file with node:http(s) rather than fetch: undici (Node 24) can hit an internal
   * assertion when a server closes the connection while a large body is paused by backpressure.
   */
  function download(bucket, key, path, signal) {
    const { url, headers } = sign('GET', bucket, key);
    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsGet : httpGet)(url, { headers, signal }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.once('error', reject);
          res.once('end', () => reject(failure('GET', bucket, key, res.statusCode, Buffer.concat(chunks).toString('utf8').slice(0, 4000))));
          return;
        }
        pipeline(res, createWriteStream(path)).then(resolve, reject);
      });
      req.once('error', reject);
    });
  }

  /** Reads and discards a response body: an unread body can trip an assertion in undici (Node 24) when the socket closes. */
  const drain = res => res.arrayBuffer().catch(() => {});

  async function putFile(bucket, key, path, { contentType, signal, forceMultipart = false } = {}) {
    const size = (await stat(path)).size;
    const type = contentType ?? contentTypeFor(path);
    const fh = await open(path, 'r');
    try {
      if (!forceMultipart && size < Math.max(partSize, MULTIPART_THRESHOLD)) {
        const body = size ? await fh.readFile() : Buffer.alloc(0);
        await drain(await request('PUT', bucket, key, { headers: { 'content-type': type }, body, signal }));
        return size;
      }
      const created = await (await request('POST', bucket, key, { query: { uploads: '' }, headers: { 'content-type': type }, signal })).text();
      const uploadId = created.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
      if (!uploadId) throw new Error(`S3 did not return an UploadId for s3://${bucket}/${key}`);
      try {
        const parts = [];
        const buf = Buffer.alloc(partSize);
        for (let offset = 0, n = 1; offset < size; offset += partSize, n++) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(partSize, size - offset), offset);
          const res = await request('PUT', bucket, key, {
            query: { partNumber: String(n), uploadId },
            body: Buffer.from(buf.subarray(0, bytesRead)),
            signal,
          });
          parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${res.headers.get('etag')}</ETag></Part>`);
          await drain(res);
        }
        const xml = `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`;
        const done = await request('POST', bucket, key, { query: { uploadId }, headers: { 'content-type': 'application/xml' }, body: xml, signal });
        const text = await done.text();
        // S3 can answer 200 with an error document.
        if (/<Error>/.test(text)) throw new Error(`S3 multipart completion failed: ${text.match(/<Message>([^<]+)/)?.[1] ?? text.slice(0, 200)}`);
      } catch (err) {
        await request('DELETE', bucket, key, { query: { uploadId } }).catch(() => {});
        throw err;
      }
      return size;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  return {
    /** Downloads an object to a local file. */
    async getFile(bucket, key, path, { signal } = {}) {
      await download(bucket, key, path, signal);
    },

    /** Uploads a local file; large files go up in parts. Returns the size. */
    putFile,

    /** Uploads every file under `dir` to `prefix` + relative path. Returns the total size. */
    async putDirectory(bucket, prefix, dir, { signal } = {}) {
      let total = 0;
      for (const file of await listFiles(dir)) {
        const rel = relative(dir, file).split(sep).join('/');
        total += await putFile(bucket, `${prefix}${rel}`, file, { signal });
      }
      return total;
    },

    async deleteObject(bucket, key, { signal } = {}) {
      await request('DELETE', bucket, key, { signal });
    },

    /** Creates a bucket; succeeds if it already exists and is yours. */
    async createBucket(bucket, { signal } = {}) {
      try {
        await request('PUT', bucket, '', { signal });
      } catch (err) {
        if (err.s3Code !== 'BucketAlreadyOwnedByYou') throw err;
      }
    },
  };
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

