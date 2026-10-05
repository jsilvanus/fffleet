import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { FleetError } from './job-record.js';

/**
 * GET a long-lived binary response as a Readable (node:http, not fetch: a body that is read
 * slowly or ended by the server must not trip fetch's body handling).
 *
 * @param {string} url
 * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} [opts]
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
export function getStream(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = url.startsWith('https:') ? httpsRequest : httpRequest;
    const req = request(url, { method: 'GET', headers, signal }, res => {
      if (res.statusCode === 200) return resolve(res);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        reject(new FleetError(body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? `HTTP ${res.statusCode}`, { status: res.statusCode }));
      });
    });
    req.once('error', reject);
    req.end();
  });
}
