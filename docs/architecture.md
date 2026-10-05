# Architecture

How fffleet is put together, and why. For the wire format see [the job contract](../README.md#the-job-contract-v1); for running it see [operations.md](operations.md).

## Goals

- **One way to run an ffmpeg job**, whether it runs in your process, on a worker, or somewhere in a pool. An application changes one setting (`FFFLEET_URL`), not its code.
- **Nothing is lost when the fleet is away.** The client falls back to running the job locally.
- **No dependencies.** Every package is plain ESM on Node 20+; the only external programs are `ffmpeg` and `ffprobe` on the machines that run jobs.
- **Generic.** fffleet knows about jobs, endpoints and capabilities, not about what the jobs are for.

## The pieces

```
┌────────────┐   createFleet({ url })    ┌──────────────┐   dispatch    ┌────────────┐
│ your app   │ ───────────────────────▶ │ orchestrator │ ────────────▶ │ worker A   │──▶ ffmpeg
│ (fffleet)  │ ◀── SSE job events ───── │  queue,      │ ◀─ heartbeat ─│ (slots,    │
└─────┬──────┘                           │  scheduler,  │               │ capabilities)
      │ no url, or fleet unreachable     │  autoscaler  │ ────────────▶ ┌────────────┐
      ▼                                  └──────┬───────┘               │ worker B   │──▶ ffmpeg
┌────────────┐                                  │ providers             └────────────┘
│ JobManager │──▶ ffmpeg (in this process)      ▼
└────────────┘                       process / docker / hetzner
```

| Package | Role | Depends on |
|---|---|---|
| `fffleet` | The contract (spec validation, states, placeholders), the **client** (`createFleet`), the local **JobManager**, the executors (`ffmpeg`, `ffprobe`), the S3 client, the input cache, auth primitives, metrics, and the shared HTTP API (`fffleet/server`). | nothing |
| `fffleet-worker` | A daemon around one `JobManager`. Serves the job API, detects capabilities, registers with an orchestrator and sends heartbeats. | `fffleet` |
| `fffleet-orchestrator` | Accepts jobs, queues them, picks a worker for each, relays events, fails jobs whose worker vanished, and starts or stops workers (autoscaling). | `fffleet` |

An application depends on `fffleet` only. The worker and the orchestrator are programs you deploy; they are also importable (`createWorker`, `createOrchestrator`) for tests and embedding.

### One API, three servers

A worker, an orchestrator and a test double all serve the same `/v1/jobs` API from the same code (`createApiHandler` in `fffleet/server`) over a small `backend` interface (`submit`, `get`, `list`, `cancel`, `writeStdin`, `closeStdin`, `openStdout`, `subscribe`, `capabilities`). The worker's backend is a `JobManager`; the orchestrator's backend queues and forwards. The client therefore cannot tell them apart, and you can point an app straight at a single worker for a small setup and add an orchestrator later without changing it.

## A job's life

1. **Validate.** `parseSpec` checks the spec and fills in defaults (`class: 'default'`, `priority: 0`, `type: 'ffmpeg'`, …). The client does this before sending anything; every server does it again.
2. **Identify.** The client picks the job id (`job_<uuid>` unless you set one). Submitting the same id with the same spec returns the existing job (HTTP 200); a different spec under that id is a 409. This is what makes retries safe.
3. **Queue.** `queued`. The queue is ordered by `priority`, then age. The orchestrator holds the fleet-wide queue; a worker holds its own (`maxQueued`, default 1000, then 503).
4. **Place** (orchestrator only, `assigned`). A worker *fits* a job if it is not draining or cooling down, accepts the job's `kind`, has a free slot in the job's class pool, and reports every capability the job needs. Candidates are ordered by load (used slots / total) and the least loaded wins. A queue entry that fits nowhere does not block the ones behind it.
5. **Stage** (`staging`, batch jobs with http(s) or s3 inputs). Inputs are downloaded into a private work directory; with a worker cache (`FFFLEET_CACHE_DIR`) the file is reused when its ETag matches.
6. **Run** (`running`). Placeholders are resolved and `ffmpeg` runs with `-progress pipe:1`; progress and the newest stderr lines stream out as events.
7. **Upload** (`uploading`, batch jobs with http(s) or s3 outputs). Outputs are PUT or uploaded (multipart for large S3 files). An output ending in `/` on S3 is a folder: every file ffmpeg wrote there is uploaded under that prefix.
8. **Finish.** `succeeded`, `failed` or `cancelled`, exactly once. The final event carries `exitCode`, `outputs` and `error`; the work directory is removed.

### Kinds, classes, slots

- A **batch** job ends by itself and has outputs (an encode, a thumbnail). A **stream** job runs until cancelled or its input ends (a relay, a live encode); it cannot use `s3:` and its http(s) endpoints are handed to ffmpeg as they are.
- A **class** names a slot pool. A worker with `FFFLEET_SLOTS=default=2,stream=1` runs at most two jobs from the `default` pool and one extra from `stream`; a class without a pool of its own uses `default`. Reserving a pool is how a long stream avoids starving encodes.
- **Kinds** (`FFFLEET_KINDS`) restrict what a worker accepts at all, so stream-only and batch-only workers can be scaled independently.

### Capabilities and placement

Capabilities are plain strings. A worker reports what it detects (`type:ffmpeg`, `type:ffprobe`, `ffmpeg:<major.minor>`, `filter:<name>`, `encoder:<name>`, `font:<family>`), what it is configured with (`FFFLEET_CAPABILITIES`, e.g. `mount:/media`), executor types (`type:<type>`), `scheme:s3` when it holds S3 credentials, and `net:<host>:<port>` for probed hosts that currently connect (`FFFLEET_PROBE`). A job's `requires` plus the implicit requirements (`type:<type>`, `scheme:s3` if it uses `s3:`) must all be present. Capabilities travel in every heartbeat, so a probe that starts failing removes the worker from scheduling within a heartbeat.

## Failure model

| Failure | What happens |
|---|---|
| Worker stops sending heartbeats (`FFFLEET_HEARTBEAT_TIMEOUT_MS`, 15 s) | Dropped; its unfinished jobs fail with `WORKER_LOST`. |
| Heartbeat no longer lists a dispatched job (worker restarted) | That job fails with `WORKER_LOST` after a short grace (`lostJobGraceMs`, 10 s). |
| Worker answers a dispatch with 5xx | No new jobs for `dispatchCooldownMs` (5 s); the job goes back to the queue. |
| Worker unreachable on dispatch | The worker is dropped until it re-registers; the job goes back to the queue. |
| Worker answers a dispatch with 4xx | The job fails with `DISPATCH_REJECTED`. |
| Orchestrator restarts, **with** `FFFLEET_STATE_FILE` | Queued jobs return to the queue; running batch jobs are adopted when their worker reports them (or fail with `ORCHESTRATOR_RESTARTED` after `FFFLEET_ADOPT_GRACE_MS`); running stream jobs fail. |
| Orchestrator restarts, without a state file | All jobs are forgotten; workers finish what they run, unobserved. |
| Fleet unreachable (client) | With `fallback: 'local'` (default) the job runs in the app's process. See the caveat in [security.md](security.md#known-limitations). |
| Event stream drops (client) | Reconnects with `Last-Event-ID` and resumes after the last event it saw; up to 5 consecutive failures. |

Event history per job is capped (500 events, always keeping the first and the final one). Finished jobs are remembered for status and idempotency (the newest 1000).

## Autoscaling

Given a config file the orchestrator runs a control loop (every `autoscale.interval`, 5 s):

1. **Sync** instances with registered workers: booting → ready on registration; booting too long → removed with backoff; ready but no longer registered → removed.
2. **Scale up.** A queued job that has waited `scaleUpAfter` goes to the first pool (in file order) that *could* serve it (`kinds`, capabilities including those observed from its running workers). Workers already on the way cover their share of waiting jobs; only the rest start new ones, bounded by the pool's `max`, `maxConcurrentCreates`, and `autoscale.maxWorkers`. A pool below its `min` is topped up.
3. **Scale down.** A worker idle for `idleAfter` (and not needed by any queued job) is drained and removed, down to the pool's `min`. Providers with hourly billing (Hetzner) only remove near the end of the paid hour.

Providers implement `list / create / destroy`: `process` (child processes, loopback), `docker` (Engine API on a socket or tcp), `hetzner` (Cloud API plus cloud-init that runs the worker image). Every instance is labelled with the orchestrator's `autoscale.id` and pool, so a restarted orchestrator **adopts** survivors and deletes strays instead of leaking paid servers.

New workers get their own **join secret**: an HMAC of the worker id under a key only the orchestrator holds (`autoscale.joinSecret`, or the signing key file). It lets that worker register under its own id and be called back; it is not the shared worker token, and nothing needs storing to recognise it again after a restart.

## Authentication model

Three kinds of caller, each with its own credential:

- **Apps** log in with a client id and secret (`POST /v1/auth/token`, OAuth2 client credentials) and get a short-lived Ed25519-signed JWT with scopes `jobs`, `metrics` or `admin`. Secrets are stored as scrypt hashes in the clients file, which is reloaded when it changes. A job's `owner` is the app that submitted it; apps see and cancel only their own jobs (someone else's job answers 404).
- **Workers** register with the **worker token** (or their join secret). The orchestrator calls workers with the same token.
- **Operators/scripts** can use the static `FFFLEET_TOKEN`, which is `admin`.

Workers fetch the orchestrator's public keys (`GET /v1/auth/keys`) and accept the same JWTs, so Prometheus can scrape a worker directly. With nothing configured, an API is **open** (convenient on localhost, dangerous elsewhere: see [security.md](security.md)).

## Storage

fffleet stores no media. Endpoints are URIs: `file:` on a shared mount (placed with a `mount:` capability), `http(s):` (PUT for outputs), `s3://` with a built-in SigV4 client (single PUT under 16 MB, multipart above; downloads use `node:http(s)` because Node 24's undici can assert on a paused body when the server closes the connection), and live schemes passed through to ffmpeg. The orchestrator's only persistent state is the optional SQLite file (job records, `node:sqlite`, Node 22.13+), the signing key and the clients file.

## Observability

Both servers serve `GET /metrics` (Prometheus text). The orchestrator reports the fleet (workers, slots, queue length by class, jobs by owner/class/state, wait and run histograms, dispatch failures, lost workers, autoscaler instances); each worker reports itself (slots, per-job speed and fps, ffmpeg CPU and memory, transfer bytes, host load). Workers are *not* proxied through the orchestrator: `GET /v1/sd/prometheus` lists them as HTTP service-discovery targets, so a dead worker shows as `up == 0`.

## Extending

- **Other job types.** An executor is `{ type, run(spec, runtime) }`. Pass `executors` to `createWorker` / `JobManager`, or list modules in `FFFLEET_EXECUTORS`. The worker advertises `type:<type>` so the orchestrator routes such jobs only there; the spec's `<type>` property carries the payload. The runtime gives you `workDir`, an abort `signal`, `setState`, `progress`, `stderr`, S3 and the input cache. `ffprobe` is built this way.
- **Other job stores.** `createOrchestrator({ store })` takes any object with `save / loadAll / prune / close`.
- **Other providers.** `createOrchestrator({ providers })` replaces a pool's provider (used by the tests).

## Repository layout

```
packages/fffleet/              contract, client, JobManager, executors, S3, auth, metrics, HTTP API
packages/fffleet-worker/       createWorker + bin
packages/fffleet-orchestrator/ createOrchestrator, autoscaler, providers, config/YAML, SQLite store + bin
docker/                        worker (ffmpeg, libass, fonts) and orchestrator images
test/e2e/                      real processes: orchestrator + two workers streaming, login, autoscaling
```

Design decisions worth knowing: one orchestrator per fleet (it owns the queue; run a second only as a cold standby on the same `/data`), one worker per machine sized by slots, idempotency by client-chosen ids rather than server-side deduplication, and capabilities as free-form strings so the scheduler needs no knowledge of what they mean.
