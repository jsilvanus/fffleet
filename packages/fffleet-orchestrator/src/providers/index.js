import { createDockerProvider } from './docker.js';
import { createHetznerProvider } from './hetzner.js';
import { createProcessProvider } from './process.js';

/**
 * One provider per pool, keyed by pool name.
 * @param {{ pools: any[] }} config
 * @param {{ onExit?: (workerId: string, code: number | null) => void, log?: (msg: string) => void, fetch?: typeof fetch, overrides?: Record<string, any> }} [opts]
 */
export function createProviders(config, { onExit, log, fetch, overrides = {} } = {}) {
  const out = {};
  for (const pool of config.pools) {
    if (overrides[pool.name]) out[pool.name] = overrides[pool.name];
    else if (pool.provider === 'process') out[pool.name] = createProcessProvider({ onExit, log });
    else if (pool.provider === 'docker') out[pool.name] = createDockerProvider({ pool, log });
    else out[pool.name] = createHetznerProvider({ pool, log, fetch });
  }
  return out;
}

export { createDockerProvider, createHetznerProvider, createProcessProvider };
