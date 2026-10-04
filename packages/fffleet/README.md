# fffleet

Run ffmpeg jobs on this machine, on an [fffleet worker](https://www.npmjs.com/package/fffleet-worker), or across a pool behind an [fffleet orchestrator](https://www.npmjs.com/package/fffleet-orchestrator), with the same code. It has no dependencies and needs Node.js 20 or newer, plus `ffmpeg` on the machine that runs the job.

```js
import { createFleet } from 'fffleet';

const fleet = createFleet({
  url: process.env.FFFLEET_URL,     // omit to always run locally
  token: process.env.FFFLEET_TOKEN,
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

`job.where` is `'local'` or `'remote'`. `fleet.capabilities()` reports slots and capabilities.

The job contract, routes and error codes are documented in the [repository README](https://github.com/jsilvanus/fffleet#the-job-contract-v1). The building blocks (`JobManager`, `validateSpec`, `followJobEvents`, …) are exported too. `fffleet/server` holds the HTTP API that the worker and the orchestrator use.

License: EUPL-1.2
