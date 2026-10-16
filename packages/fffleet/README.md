# fffleet

Run ffmpeg jobs on this machine, on an [fffleet worker](https://www.npmjs.com/package/fffleet-worker), or across a pool behind an [fffleet orchestrator](https://www.npmjs.com/package/fffleet-orchestrator), with the same code. The core package has no npm dependencies and needs Node.js 20 or newer, plus `ffmpeg` on the machine that runs the job. The optional isolated runtime also needs Podman (preferred) or Docker, plus Linux tmpfs with host swap disabled.

```js
import { createFleet } from 'fffleet';

const fleet = createFleet({
  url: process.env.FFFLEET_URL,     // omit to always run locally
  token: process.env.FFFLEET_TOKEN, // or log in as an app: clientId + clientSecret (refreshed automatically)
  fallback: 'local',                // run here if the fleet is unreachable (default); 'none' to throw
  local: { slots: { default: 2 } }, // options for the local runner
});

const job = await fleet.submit({
  kind: 'stream',
  class: 'stream',
  inputs: [{ name: 'in', uri: 'rtmp://ingest.example/live/key' }],
  outputs: [{ name: 'hls', uri: 'file:///media/live/index.m3u8' }],
  ffmpeg: { args: ['-i', '{{input:in}}', '-c', 'copy', '-f', 'hls', '{{output:hls}}'] },
});

job.on('state', state => console.log(job.id, state));
// later
await job.cancel();
const final = await job.done; // final snapshot: state, error, outputs, exitCode, stderrTail
```

While a job runs, `job.on('stderr', tail => ...)` and `job.stderrTail` give ffmpeg's newest stderr lines, which is how you diagnose a stream job that never exits.

`job.where` is `'local'` or `'remote'`. `fleet.capabilities()` reports slots and capabilities.

The job contract, routes and error codes are documented in the [repository README](https://github.com/jsilvanus/fffleet#the-job-contract-v1). The building blocks (`JobManager`, `validateSpec`, `followJobEvents`, …) are exported too. `fffleet/server` holds the HTTP API that the worker and the orchestrator use.

## Opt-in isolated command runtime

For trusted custom executors, `runIsolatedCommand()` runs a command in a fresh container (Podman by default; Docker CLI optional), with no host bind mounts, no network, a read-only root filesystem, tmpfs scratch, dropped capabilities, no-new-privileges and resource limits. Inputs must already be staged in `workDir/in`; regular output files are copied back to `workDir/out`.

```js
import { runIsolatedCommand } from 'fffleet';

// Inside a trusted custom executor, after staging only authorized inputs into runtime.workDir/in:
const result = await runIsolatedCommand({
  image: 'registry.example.org/trusted-toolchain:1.2.3', // pin/allow-list images in your application
  command: '/usr/local/bin/build-project',
  args: ['--input', '/work/in', '--output', '/work/out'],
  env: { FFFLEET_INPUT_DIR: '/work/in', FFFLEET_OUTPUT_DIR: '/work/out' },
  workDir: runtime.workDir,
  signal: runtime.signal,
});
```

The worker's `FFFLEET_WORK_DIR` must point to Linux tmpfs (for example, under `/dev/shm`) on a host with swap disabled; the helper refuses non-tmpfs scratch and active/unverifiable host swap by default. The image must include `/bin/sh`, `sleep`, `find` and GNU `tar`. The caller must stage inputs through trusted, authorized code and handle output upload/publication itself. This is a low-level opt-in primitive, **not** automatic isolation for ordinary FFmpeg jobs, a tenant authorization system, or a guarantee against container-runtime/kernel vulnerabilities. Prefer rootless Podman.

See also the [integration guide](https://github.com/jsilvanus/fffleet/blob/main/docs/integration-guide.md).

License: EUPL-1.2
