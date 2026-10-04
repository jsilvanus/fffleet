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

## Autoscaling

Give the orchestrator a config file and it starts workers when jobs wait and removes them when they are idle. Pools are tried in the order they are written, so put free capacity first and paid capacity last. The format is YAML (JSON also works); [`fffleet.example.yaml`](fffleet.example.yaml) is a complete example.

```yaml
publicUrl: https://orchestrator.example.com   # how new workers reach the orchestrator (docker, hetzner)
autoscale:
  scaleUpAfter: 10s     # a job must wait this long before it starts a worker
  idleAfter: 5m
  maxWorkers: 10
pools:
  - name: local
    provider: process   # child processes of the orchestrator, on its own machine
    max: 2
    kinds: [batch]
    slots: auto
  - name: cloud
    provider: hetzner
    max: 5
    kinds: [batch, stream]
    slots: auto
    hetzner: { token: "${HCLOUD_TOKEN}", serverType: cpx41, location: hel1 }
```

```sh
FFFLEET_CONFIG=fffleet.yaml FFFLEET_TOKEN=c npx fffleet-orchestrator    # or --config fffleet.yaml
```

- **Providers:** `process` starts workers beside the orchestrator (install `fffleet-worker`, or set `process.command`). `docker` starts containers on a Docker network the orchestrator shares (mount the Docker socket, set `docker.network`). `hetzner` creates Cloud servers that run the worker image, labelled so a restarted orchestrator finds them again, and deletes them near the end of their paid hour once idle.
- **Pool settings:** `min` (kept running; default 0), `max` (default 1), `kinds`, `slots`, `capabilities`, `env` (given to its workers), `idleAfter`, `maxConcurrentCreates`. A job goes to the first pool that has the kind and capabilities it needs. S3 credentials in a pool's `env` give the pool `scheme:s3`.
- **Slots:** a worker's `slots` (or `FFFLEET_SLOTS`) can be `auto`, sized from its CPU count: batch only gets cores/2 slots, stream only gets cores slots, and a worker taking both gets `default` = cores/2 plus `stream` = cores/4. `auto:N` assumes N cores per slot. Explicit values (`default=2,stream=1`) still work.
- **Kinds:** a worker takes `batch` jobs (finish and exit: encodes), `stream` jobs (run until stopped: relays, live encodes), or both (`FFFLEET_KINDS`, default both). Stream workers are best sized by slots only, and batch workers are the ones to scale down freely.
- **Joining:** each new worker is given its own join secret, derived from the orchestrator's signing key (`FFFLEET_SIGNING_KEY_FILE`) or `autoscale.joinSecret`. Set one of them, or workers started before an orchestrator restart cannot rejoin.
- **Watching:** `GET /v1/pools` (admin) shows instances per pool, and `fffleet_autoscaler_*` metrics count them, creations and removals.
- **Hetzner notes:** the orchestrator must be reachable at `publicUrl` from the new servers (use HTTPS in front of it, or a private `network` with `advertise: private`); the `fffleet-worker` image must be pullable (public on ghcr, or set `hetzner.registry`); restrict the worker port with a firewall.

## Logins: many apps, one orchestrator

Each app that uses the orchestrator gets its own client id and secret and logs in for a short-lived token (OAuth2 client credentials, `POST /v1/auth/token`). Apps never share a secret, and removing an app ends its access.

```sh
export FFFLEET_CLIENTS_FILE=/data/clients.json FFFLEET_SIGNING_KEY_FILE=/data/signing.pem
npx fffleet-orchestrator add-client video-app --scope jobs            # prints the secret once
npx fffleet-orchestrator add-client prometheus --scope metrics
FFFLEET_WORKER_TOKEN=worker-secret npx fffleet-orchestrator
```

```js
const fleet = createFleet({ url: process.env.FFFLEET_URL, clientId: 'video-app', clientSecret: process.env.FFFLEET_SECRET });
```

The client logs in on its first request, reuses the token and logs in again before it expires (and once more on a 401).

- **Scopes.** `jobs` submits and manages jobs, `metrics` reads `/metrics` and service discovery, `admin` does everything and sees every app's jobs. An app can ask for fewer scopes than it has (`scope: 'jobs'`).
- **Ownership.** A job's `owner` is the app that logged in, whatever the spec says. An app sees, cancels and follows only its own jobs; someone else's job answers 404 like a job that does not exist. `admin` and the static token see all.
- **Tokens.** Ed25519-signed JWTs, one hour by default (`FFFLEET_TOKEN_TTL_SECONDS`). Keep the signing key in `FFFLEET_SIGNING_KEY_FILE` (created on first start) so tokens survive a restart; without it they are valid only until the orchestrator restarts. Secrets are stored only as scrypt hashes. The clients file is re-read when it changes, so removing a client takes effect within a second.
- **Workers** fetch the public keys from `GET /v1/auth/keys` and accept the same tokens, so Prometheus can scrape a worker directly. The orchestrator itself reaches workers with `FFFLEET_WORKER_TOKEN`, which also grants admin on the worker: keep workers on a private network.
- **Static token.** `FFFLEET_TOKEN` keeps working beside logins and is treated as admin; it suits one trusted app or scripts.
- **Transport.** Tokens and secrets travel in headers: put the orchestrator behind TLS (a reverse proxy) when it is reachable from anywhere you do not trust.

## Metrics

The orchestrator and every worker serve `GET /metrics` in the Prometheus text format, for tokens with the `metrics` scope (or the static token).

| Where | What |
|---|---|
| Orchestrator (the fleet) | `fffleet_workers`, `fffleet_worker_slots{,_used}`, `fffleet_worker_heartbeat_age_seconds`, `fffleet_worker_draining`, `fffleet_queue_length{class}`, `fffleet_jobs{owner,class,state}`, `fffleet_jobs_submitted_total`, `fffleet_jobs_finished_total{state,code}`, `fffleet_job_wait_seconds` and `fffleet_job_run_seconds` histograms, `fffleet_dispatch_failures_total`, `fffleet_workers_lost_total`, `fffleet_auth_*` |
| Worker (this machine) | `fffleet_slots{,_used}`, the same job metrics for jobs it ran, `fffleet_job_speed` and `fffleet_job_fps` of running jobs, `fffleet_ffmpeg_cpu_seconds` and `fffleet_ffmpeg_resident_memory_bytes` per ffmpeg process (Linux), `fffleet_transfer_bytes_total{direction,scheme}`, host CPUs, load, memory and free work-directory space |
| Both | `process_*`, `fffleet_build_info` |

Workers are not scraped through the orchestrator: each one answers for itself, so a lost worker shows up as a failed scrape (`up == 0`) and the orchestrator needs no second copy of every number. `GET /v1/sd/prometheus` is a Prometheus [HTTP service discovery](https://prometheus.io/docs/prometheus/latest/http_sd/) endpoint listing the registered workers, so you configure only the orchestrator:

```yaml
scrape_configs:
  - job_name: fffleet-orchestrator
    oauth2: { client_id: prometheus, client_secret_file: /etc/prometheus/fffleet-secret, token_url: http://orchestrator:5000/v1/auth/token }
    static_configs: [{ targets: ['orchestrator:5000'] }]
  - job_name: fffleet-workers
    oauth2: { client_id: prometheus, client_secret_file: /etc/prometheus/fffleet-secret, token_url: http://orchestrator:5000/v1/auth/token }
    http_sd_configs:
      - url: http://orchestrator:5000/v1/sd/prometheus
        oauth2: { client_id: prometheus, client_secret_file: /etc/prometheus/fffleet-secret, token_url: http://orchestrator:5000/v1/auth/token }
```

## The job contract (v1)

One resource, `/v1/jobs`, served the same way by a worker and by the orchestrator.

- **Kinds.** A `batch` job ends by itself and has outputs; a `stream` job (a live relay, an HLS encoder) runs until it is cancelled or its input ends.
- **States.** `queued → assigned → staging → running → uploading → succeeded | failed | cancelled`. `assigned` happens only in the orchestrator; `staging` and `uploading` only when there are http(s) inputs or outputs to move.
- **Endpoints.** Inputs and outputs are named URIs used as `{{input:name}}` / `{{output:name}}` in the ffmpeg arguments.
  - `file:` is used in place, so the path has to exist on the worker (a shared mount).
  - `http(s):` inputs of a batch job are downloaded before ffmpeg starts, and outputs are uploaded with `PUT` after it ends. A stream job hands them to ffmpeg as they are.
  - `s3://bucket/key` (batch jobs) is downloaded before ffmpeg starts or uploaded after it ends (multipart for large files) by a worker that holds S3 credentials. An output ending in `/` is a folder: `{{output:name}}` is a directory and every file ffmpeg writes there is uploaded under that prefix, e.g. `'-hls_segment_filename', '{{output:hls}}/seg%03d.ts', '{{output:hls}}/index.m3u8'`. Such jobs go only to workers that report `scheme:s3`.
  - `rtmp(s):`, `srt:`, `udp:`, `tcp:`, `rtsp:` and `rtp:` always go to ffmpeg as they are.
- **Ids.** The client picks the id. Submitting the same id and spec again returns the existing job (200), and a different spec under the same id is a conflict (409). A retry or a local fallback can therefore never run a job twice.
- **Classes and slots.** Every job draws a slot from the pool named by its `class` (`default` unless set). A worker with `FFFLEET_SLOTS=default=2,stream=1` keeps one slot for streams that batch work cannot take.
- **Placement.** `requires: ['filter:ass', 'font:DejaVu Sans']` sends a job only to workers that report those capabilities. Workers detect `type:ffmpeg`, `ffmpeg:<version>`, `filter:*`, `encoder:*` and `font:*`, and you can add your own with `FFFLEET_CAPABILITIES` (for example `mount:/media`).
- **Priority** (-1000..1000) orders the queue. **timeoutMs** fails a job that runs too long. **stdin: true** keeps ffmpeg's stdin open for `POST /v1/jobs/:id/stdin`.
- **Events.** `GET /v1/jobs/:id/events` is a Server-Sent Events stream of `event: job` messages, each with a `seq`. Reconnecting with `Last-Event-ID` resumes after that event. The stream ends with the final event.

| Route | |
|---|---|
| `GET /v1/health` | No auth. |
| `POST /v1/auth/token` | Orchestrator only. Client credentials in, bearer token out (see Logins). |
| `GET /v1/auth/keys` | Orchestrator only, public. The token signing keys (JWKS). |
| `GET /metrics` | `metrics` scope. Prometheus text format. |
| `GET /v1/sd/prometheus` | Orchestrator only, `metrics` scope. Workers as Prometheus targets. |
| `GET /v1/capabilities` | Slots, queue length and capabilities (summed over the pool on the orchestrator). |
| `POST /v1/jobs` | 201 started, 202 queued, 200 already known, 409 id conflict, 422 invalid spec, 503 queue full (with `retry-after`). |
| `GET /v1/jobs`, `GET /v1/jobs/:id` | Snapshots. |
| `DELETE /v1/jobs/:id` | Cancels (202). |
| `GET /v1/jobs/:id/events` | SSE, see above. |
| `POST /v1/jobs/:id/stdin` | Raw body written to ffmpeg. |
| `POST /v1/workers/register` | Orchestrator only, worker token. Also the heartbeat. |
| `GET /v1/workers`, `POST /v1/workers/:id/drain` | Orchestrator only, `admin` scope. |

Errors look like `{ "error": { "code": "QUEUE_FULL", "message": "..." } }`.

## Storage

fffleet has no storage of its own: inputs and outputs are wherever their URIs point.

- **Shared volume:** `file:` paths that every worker mounts (the compose example uses `/media`).
- **S3 or S3-compatible (MinIO, Ceph, Garage, ...):** give workers credentials and use `s3://` URIs. Workers read `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN` and `AWS_REGION`, and for non-AWS stores `FFFLEET_S3_ENDPOINT` (and `FFFLEET_S3_PATH_STYLE=1`, the usual setting for MinIO). For the local runner pass `local: { s3: s3ConfigFromEnv() }` to `createFleet`.
- **Presigned URLs:** without credentials on the workers, `https://` presigned GET and PUT URLs work for single files (one PUT, so at most 5 GB on S3).

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
