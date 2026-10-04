# fffleet

**fast forward fleet**: run ffmpeg jobs on this machine, on one worker, or across a pool of workers, through one client and one job contract.

| Package | What it is |
|---|---|
| [`fffleet`](packages/fffleet) | The client library, the job contract and the local runner. No dependencies. |
| [`fffleet-worker`](packages/fffleet-worker) | A daemon that runs jobs on one machine and serves the job API. Docker image `ghcr.io/jsilvanus/fffleet-worker`. |
| [`fffleet-orchestrator`](packages/fffleet-orchestrator) | Queues jobs and spreads them over registered workers. Docker image `ghcr.io/jsilvanus/fffleet-orchestrator`. |

An application only ever depends on `fffleet`. Where jobs run is configuration:

```js
import { createFleet } from 'fffleet';

// No url: jobs run here. With a url (a worker or an orchestrator, same API): they run there,
// and with fallback 'local' (the default) they run here when the fleet cannot be reached.
const fleet = createFleet({ url: process.env.FFFLEET_URL, token: process.env.FFFLEET_TOKEN });

const job = await fleet.submit({
  kind: 'batch',
  inputs: [{ name: 'src', uri: 'https://example.org/in.mp4' }],
  outputs: [{ name: 'thumb', uri: 'file:///media/out/thumb.jpg' }],
  ffmpeg: { args: ['-ss', '5', '-i', '{{input:src}}', '-frames:v', '1', '{{output:thumb}}'] },
});
job.on('progress', p => console.log(p.pct));
const result = await job.done; // { state: 'succeeded' | 'failed' | 'cancelled', outputs, error, ... }
```

## Running a fleet

```sh
FFFLEET_TOKEN=client-secret FFFLEET_WORKER_TOKEN=worker-secret docker compose up --build
```

[`docker-compose.yml`](docker-compose.yml) starts an orchestrator on port 5000 and two workers that share `./media` at `/media`. Without Docker:

```sh
FFFLEET_TOKEN=c FFFLEET_WORKER_TOKEN=w npx fffleet-orchestrator
FFFLEET_ORCHESTRATOR_URL=http://localhost:5000 FFFLEET_WORKER_TOKEN=w PORT=5101 npx fffleet-worker
```

## The job contract (v1)

One resource, `/v1/jobs`, served the same way by a worker and by the orchestrator.

- **Kinds.** A `batch` job ends by itself and has outputs; a `stream` job (a live relay, an HLS encoder) runs until it is cancelled or its input ends.
- **States.** `queued → assigned → staging → running → uploading → succeeded | failed | cancelled`. `assigned` happens only in the orchestrator; `staging` and `uploading` only when there are http(s) inputs or outputs to move.
- **Endpoints.** Inputs and outputs are named URIs used as `{{input:name}}` / `{{output:name}}` in the ffmpeg arguments.
  - `file:` is used in place, so the path has to exist on the worker (a shared mount).
  - `http(s):` inputs of a batch job are downloaded before ffmpeg starts, and outputs are uploaded with `PUT` after it ends. A stream job hands them to ffmpeg as they are.
  - `rtmp(s):`, `srt:`, `udp:`, `tcp:`, `rtsp:` and `rtp:` always go to ffmpeg as they are.
- **Ids.** The client picks the id. Submitting the same id and spec again returns the existing job (200), and a different spec under the same id is a conflict (409). A retry or a local fallback can therefore never run a job twice.
- **Classes and slots.** Every job draws a slot from the pool named by its `class` (`default` unless set). A worker with `FFFLEET_SLOTS=default=2,stream=1` keeps one slot for streams that batch work cannot take.
- **Placement.** `requires: ['filter:ass', 'font:DejaVu Sans']` sends a job only to workers that report those capabilities. Workers detect `type:ffmpeg`, `ffmpeg:<version>`, `filter:*`, `encoder:*` and `font:*`, and you can add your own with `FFFLEET_CAPABILITIES` (for example `mount:/media`).
- **Priority** (-1000..1000) orders the queue. **timeoutMs** fails a job that runs too long. **stdin: true** keeps ffmpeg's stdin open for `POST /v1/jobs/:id/stdin`.
- **Events.** `GET /v1/jobs/:id/events` is a Server-Sent Events stream of `event: job` messages, each with a `seq`. Reconnecting with `Last-Event-ID` resumes after that event. The stream ends with the final event.

| Route | |
|---|---|
| `GET /v1/health` | No auth. |
| `GET /v1/capabilities` | Slots, queue length and capabilities (summed over the pool on the orchestrator). |
| `POST /v1/jobs` | 201 started, 202 queued, 200 already known, 409 id conflict, 422 invalid spec, 503 queue full (with `retry-after`). |
| `GET /v1/jobs`, `GET /v1/jobs/:id` | Snapshots. |
| `DELETE /v1/jobs/:id` | Cancels (202). |
| `GET /v1/jobs/:id/events` | SSE, see above. |
| `POST /v1/jobs/:id/stdin` | Raw body written to ffmpeg. |
| `POST /v1/workers/register` | Orchestrator only, worker token. Also the heartbeat. |
| `GET /v1/workers`, `POST /v1/workers/:id/drain` | Orchestrator only. |

Errors look like `{ "error": { "code": "QUEUE_FULL", "message": "..." } }`.

## Failure handling

- A worker sends a heartbeat (`FFFLEET_HEARTBEAT_MS`, 5 s by default) listing its unfinished jobs.
  - A worker that is silent for `FFFLEET_HEARTBEAT_TIMEOUT_MS` (15 s) is dropped, and its jobs fail with `WORKER_LOST`.
  - So does a job its heartbeat stops listing, which happens when the worker restarted.
- A worker that answers a dispatch with 5xx gets no new jobs for a while, and the job goes back to the queue. A 4xx fails the job with `DISPATCH_REJECTED`.
- The orchestrator keeps its state in memory. If it restarts, it forgets its queue, while the workers finish what they were running.

## Development

```sh
npm install
npm test            # unit tests, then the end-to-end tests (needs ffmpeg on PATH)
npm run test:e2e    # an orchestrator and two workers as real processes, streaming red and green
```

Releases use [Changesets](https://github.com/changesets/changesets):

1. A pull request with a user-visible change adds a changeset (`npm run changeset`).
2. On `main`, the release workflow keeps a **Version Packages** pull request up to date.
3. Merging that pull request publishes the three packages to npm (trusted publishing, no token) and pushes both images to ghcr.io under the new version.

The three packages always share a version.

## License

[EUPL-1.2](LICENSE)
