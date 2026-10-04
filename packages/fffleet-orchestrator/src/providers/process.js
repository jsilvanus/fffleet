import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const KILL_GRACE_MS = 5000;

function workerCommand(options) {
  if (Array.isArray(options.command) && options.command.length) return options.command.map(String);
  try {
    const pkg = createRequire(import.meta.url).resolve('fffleet-worker/package.json');
    return [process.execPath, join(dirname(pkg), 'bin', 'fffleet-worker.js')];
  } catch {
    throw new Error('the process provider needs the fffleet-worker package (npm install fffleet-worker) or a "command" to start a worker with');
  }
}

/**
 * Starts workers as child processes of the orchestrator, on this machine. They listen on a free
 * loopback port and are stopped when the orchestrator stops.
 *
 * @param {object} [opts]
 * @param {(workerId: string) => void} [opts.onExit]   Called when a worker exits on its own.
 * @param {(msg: string) => void} [opts.log]
 */
export function createProcessProvider({ onExit = () => {}, log = () => {} } = {}) {
  /** @type {Map<string, import('node:child_process').ChildProcess>} */
  const children = new Map();

  return {
    name: 'process',
    billing: null,

    async list() {
      return []; // children do not outlive the orchestrator
    },

    async create({ workerId, pool, env }) {
      const [cmd, ...args] = workerCommand(pool.options);
      // Workers must not inherit the orchestrator's own credentials: scrub FFFLEET_* and set what they need.
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FFFLEET_')));
      const child = spawn(cmd, args, {
        cwd: pool.options.cwd || undefined,
        env: { ...inherited, HOST: '127.0.0.1', PORT: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const providerId = String(child.pid ?? workerId);
      children.set(providerId, child);
      const relay = chunk => {
        for (const line of chunk.toString().split('\n')) if (line.trim()) log(`[${workerId}] ${line.trim()}`);
      };
      child.stdout.on('data', relay);
      child.stderr.on('data', relay);
      child.once('exit', code => {
        if (children.delete(providerId)) onExit(workerId, code);
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return { providerId };
    },

    async destroy(providerId) {
      const child = children.get(providerId);
      if (!child) return;
      children.delete(providerId);
      await stop(child);
    },

    async close() {
      await Promise.all([...children.values()].map(stop));
      children.clear();
    },
  };
}

function stop(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const kill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
