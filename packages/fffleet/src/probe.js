import { connect, isIP } from 'node:net';

/**
 * Network reachability probes. A worker given `mediamtx=10.1.2.3:8554` tries a TCP connect to it and, while that
 * works, advertises `net:10.1.2.3:8554` and `net:mediamtx`, so a job with `requires: ['net:mediamtx']` only goes
 * to workers that can reach the host from where they run. A host name without an alias (a docker service name)
 * is advertised as `net:<name>` too.
 */

const ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Parses `[alias=]host:port[,...]` (an optional `tcp://` prefix is accepted; IPv6 as `[::1]:8554`).
 * Hosts are lower-cased. Throws on a malformed entry, so a typo does not silently disable a probe.
 *
 * @param {string | string[] | undefined} input
 * @returns {{ host: string, port: number, alias: string | null, capabilities: string[] }[]}
 */
export function parseProbes(input) {
  const entries = Array.isArray(input) ? input : String(input ?? '').split(',');
  return entries.map(e => String(e).trim()).filter(Boolean).map(entry => {
    let rest = entry;
    let alias = null;
    const eq = rest.indexOf('=');
    if (eq !== -1) {
      alias = rest.slice(0, eq).trim();
      rest = rest.slice(eq + 1).trim();
      if (!ALIAS_RE.test(alias)) throw new Error(`probe "${entry}": alias must be 1-64 characters of A-Z a-z 0-9 . _ -`);
    }
    rest = rest.replace(/^tcp:\/\//i, '');
    const m = rest.match(/^(\[[0-9a-fA-F:.]+\]|[^:\s/\[\]]+):(\d{1,5})$/);
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) throw new Error(`probe "${entry}": expected [alias=]host:port`);
    const host = m[1].toLowerCase();
    // A name (a docker service, a DNS name) is also advertised on its own; an IP only with its port.
    const bare = !alias && !isIP(host.replace(/^\[|\]$/g, '')) ? [`net:${host}`] : [];
    const capabilities = [`net:${host}:${port}`, ...(alias ? [`net:${alias}`] : bare)];
    return { host, port, alias, capabilities };
  });
}

/** True when a TCP connection to host:port opens within `timeoutMs`. */
export function canConnect(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const socket = connect({ host: host.replace(/^\[|\]$/g, ''), port });
    const done = ok => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The `net:` capabilities of the probes that currently connect.
 *
 * @param {ReturnType<typeof parseProbes>} probes
 * @param {{ timeoutMs?: number, connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean> }} [opts]
 * @returns {Promise<string[]>}
 */
export async function probeCapabilities(probes, { timeoutMs = 3000, connect: tryConnect = canConnect } = {}) {
  const results = await Promise.all(probes.map(async p => ((await tryConnect(p.host, p.port, timeoutMs)) ? p.capabilities : [])));
  return [...new Set(results.flat())].sort();
}
