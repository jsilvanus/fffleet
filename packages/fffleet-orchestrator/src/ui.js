import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The static dashboard that ships with the orchestrator (plain HTML, CSS and ESM; no build step). */
export const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * Serves /ui and /ui/* from UI_DIR. Returns false for any other path.
 * The files hold no data: the page logs in through /v1/auth/token and reads the API with the token it got.
 */
export async function serveUi(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname === '/ui') {
    res.writeHead(301, { location: '/ui/' });
    res.end();
    return true;
  }
  if (!pathname.startsWith('/ui/')) return false;
  const rel = decodeURIComponent(pathname.slice('/ui/'.length)) || 'index.html';
  const file = normalize(join(UI_DIR, rel));
  const type = TYPES[extname(file)];
  // Refuse anything outside the directory, and anything without a known type.
  if (!file.startsWith(UI_DIR + sep) || !type) return notFound(res);
  let body;
  try {
    body = await readFile(file);
  } catch {
    return notFound(res);
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
  return true;
}
