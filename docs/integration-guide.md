# Integration guide

How to build an application on fffleet: what to submit, how to follow it, how to move media, and the patterns that have worked. It assumes you have read [Install and use](getting-started.md).

## The shape of an integration

1. **Create one fleet client per process** at start-up and close it at shutdown.
2. **Describe the work as a spec** (kind, endpoints, ffmpeg arguments, placement needs).
3. **Give the job a stable id** that your application owns.
4. **Follow it** through events, or just await `job.done`.
5. **Read the result** from the final snapshot, not from exceptions.

```js
import { createFleet } from 'fffleet';

export const fleet = createFleet({
  url: process.env.FFFLEET_URL || undefined,           // unset = run locally
  clientId: process.env.FFFLEET_CLIENT_ID,
  clientSecret: process.env.FFFLEET_CLIENT_SECRET,
  fallback: 'local',
  local: { slots: 'auto' },
});
process.once('SIGTERM', () => fleet.close());
```

Keep the "no URL" path working. It is the development and the disaster-recovery configuration, and it makes your tests need nothing but ffmpeg.

## Specs

| Field | Notes |
|---|---|
| `kind` | `batch` (finishes, has outputs) or `stream` (runs until stopped). Required. |
| `inputs`, `outputs` | `[{ name, uri, contentType? }]`. Names are `A-Za-z0-9_-`, unique per list. |
| `ffmpeg.args` | Arguments only. Use `{{input:name}}`, `{{output:name}}`, `{{inputdir:name}}`. Unknown names fail validation (422) before anything runs. |
| `ffmpeg.durationMs` | Expected output length, so progress has a percentage. |
| `id` | Client-chosen, 1-128 chars `A-Za-z0-9._:-`. Defaults to `job_<uuid>`. |
| `class` | Slot pool (`default`, or a pool the workers define such as `stream`). |
| `priority` | -1000..1000, higher first. |
| `requires` | Capabilities a worker must report, e.g. `['filter:ass', 'encoder:libx264', 'font:DejaVu Sans', 'mount:/media', 'net:mediamtx']`. |
| `timeoutMs` | Fails the job with `TIMEOUT` if it runs longer. |
| `labels` | Free string map for your own bookkeeping (returned in snapshots). |
| `owner` | Set by the server to the logged-in app; do not rely on supplying it. |
| `stdin` / `stdout` | Pipe data into / out of a running job (below). |
| `type` | `ffmpeg` (default), `ffprobe`, or a type a worker has loaded. |

Use `validateSpec(spec)` from `fffleet` in your own tests to check specs without running anything; it returns `{ ok, spec }` or `{ ok: false, errors }`.

## Idempotency and retries

The server remembers a job by id. Submitting the same id with an identical spec returns the existing job (200) and never starts it twice; a different spec under the same id is `409 ID_CONFLICT`. So:

- **Derive ids from your own entity**, e.g. `render-<projectId>-<revision>`. A crashed app that resubmits after restart reattaches to the running job instead of duplicating it.
- To rerun a finished job, change the id (add an attempt counter). A finished job is remembered for status until it falls out of the newest 1000.
- Ids are one namespace for the whole orchestrator, not per app. Two apps picking the same id see a 409 even though they cannot see each other's jobs; prefix ids with your app's name.

## Following a job

```js
const job = await fleet.submit(spec);

job.on('state',    (state, event) => {});          // queued → assigned → staging → running → uploading → final
job.on('progress', (p) => bar(p.pct, p.speed));    // { pct|null, outTimeMs, speed, fps, frame }
job.on('stderr',   (tail) => {});                  // ffmpeg's newest stderr lines while it runs

const final = await job.done;                       // JobSnapshot; check final.state
await job.cancel();                                 // DELETE /v1/jobs/:id
```

- Remote events are Server-Sent Events with sequence numbers; the client reconnects with `Last-Event-ID` and resumes. `done` **rejects** only if the event stream is lost for good (the fleet is gone); treat that as "state unknown", and look the job up again by id after the fleet is back (submit the same spec, or `GET /v1/jobs/:id`).
- `handle.where` is `'local'` or `'remote'`, so you can log where a job actually ran, including after a fallback.
- Error `code`s you will see: `FFMPEG_EXIT`, `INPUT_FAILED`, `UPLOAD_FAILED`, `OUTPUT_MISSING`, `TIMEOUT`, `CANCELLED`, `WORKER_LOST`, `DISPATCH_REJECTED`, `ORCHESTRATOR_RESTARTED`, `INVALID_SPEC`, `UNSUPPORTED_TYPE|KIND|SCHEME`, `SPAWN_FAILED`. Submission-time errors (`QUEUE_FULL` 503, `ID_CONFLICT` 409, `INVALID_SPEC` 422, `UNAUTHORIZED` 401, `FORBIDDEN` 403) are thrown by `submit` as `FleetError` with `.code` and `.status`.
- `WORKER_LOST` and `ORCHESTRATOR_RESTARTED` mean "I do not know whether it finished". Safe jobs (idempotent outputs) can simply be resubmitted under a new id.

## Getting media to and from workers

Pick one storage model per deployment:

| Model | Inputs/outputs | Use when |
|---|---|---|
| **Shared mount** | `file:///media/...` | Workers and app share a filesystem (NFS, a compose volume). Mark workers `FFFLEET_CAPABILITIES=mount:/media` and add `requires: ['mount:/media']` to jobs so a worker without the mount is never chosen. |
| **S3 / S3-compatible** | `s3://bucket/key` | Workers hold `AWS_*` credentials (and `FFFLEET_S3_ENDPOINT` + `FFFLEET_S3_PATH_STYLE=1` for MinIO, Ceph, Garage…). Workers download inputs, upload outputs (multipart above 16 MB) and are the only holders of the credentials. Jobs using `s3:` go only to workers with `scheme:s3`. Batch jobs only. |
| **HTTP(S)** | `https://...` | Presigned GET/PUT URLs, no credentials on workers. One PUT per output (5 GB on S3). Presigned URLs appear in the job record: use short expiry. |
| **Live** | `rtmp(s):`, `srt:`, `udp:`, `tcp:`, `rtsp:`, `rtp:` | Passed to ffmpeg as is. The *worker* must be able to reach the address: use `FFFLEET_PROBE=name=host:port` and `requires: ['net:name']` so only workers that can reach it are chosen. |

S3 notes:

- An output URI ending in `/` is a **folder**: `{{output:hls}}` becomes a directory and every file ffmpeg writes under it is uploaded below that prefix: `'-hls_segment_filename', '{{output:hls}}/seg%03d.ts', '{{output:hls}}/index.m3u8'`.
- For the same large source used by many jobs, set `FFFLEET_CACHE_DIR` on workers: staged `s3://` and `http(s)://` inputs are kept (LRU, `FFFLEET_CACHE_MAX_SIZE`, default 20 GB) and reused while their ETag matches.
- `{{inputdir:name}}` is the directory of a staged input, for options that take a directory, such as fonts for the `ass` filter (`ass=subs.ass:fontsdir={{inputdir:font}}`).

## Choosing a worker: capabilities

Ask for what you need, not for a machine:

```js
await fleet.submit({
  kind: 'batch',
  requires: ['filter:ass', 'font:DejaVu Sans', 'encoder:libx264'],
  // ...
});
```

`await fleet.capabilities()` (or `GET /v1/capabilities`) shows the union the fleet offers. A job whose `requires` no worker can satisfy stays `queued` (and, with autoscaling, may trigger a pool that declares those capabilities); consider a `timeoutMs` or your own watchdog on queue time.

## Stream jobs

For relays and live encodes (`kind: 'stream'`):

- They run until cancelled or their input ends; use a dedicated class (`class: 'stream'`) so a handful of long streams cannot occupy every encode slot.
- `job.stderrTail` / `job.on('stderr')` is your window into a stream that never "finishes".
- A restart of the orchestrator fails running stream jobs (`ORCHESTRATOR_RESTARTED`); your app's supervisor should resubmit them.
- **Piping data:** `stdin: true` lets you `await job.write(chunk)` and `await job.endStdin()` (EOF). `stdout: true` (stream jobs) lets you read ffmpeg's `pipe:1` as a `Readable` from `await job.stdout()`: raw PCM for a speech-to-text service, frames for an analyser. One reader per job; ffmpeg stalls while nobody reads; no `-progress` is reported for such a job.

```js
const job = await fleet.submit({
  kind: 'stream', class: 'stream', stdout: true,
  inputs: [{ name: 'in', uri: 'rtmp://ingest.example/live/key' }],
  ffmpeg: { args: ['-i', '{{input:in}}', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'] },
});
for await (const chunk of await job.stdout()) consume(chunk);
```

## Custom job types

When the work is not ffmpeg (a model run, a file conversion) but should share the fleet's placement, queueing and auth, add an **executor** to the workers:

```js
// my-job.js
export default {
  type: 'transcribe',
  async run(spec, rt) {
    rt.setState('running');
    const text = await doTheWork(spec.transcribe, { signal: rt.signal });   // honour rt.signal for cancel/timeout
    return { exitCode: 0, outputs: [{ name: 'result', uri: 'inline:', bytes: text.length, data: { text } }], stderrTail: null };
  },
};
```

```sh
FFFLEET_EXECUTORS=./my-job.js npx fffleet-worker
```

```js
await fleet.submit({ kind: 'batch', type: 'transcribe', transcribe: { url: '...' } });   // routed to workers claiming type:transcribe
```

Executors are trusted code that runs with the worker's privileges. The `runtime` offers `workDir` (private, deleted afterwards), `signal`, `setState`, `progress`, `stderr`, `transfer`, `s3`, `cache`, and `fetch`. Small results travel inline in `outputs[].data`.

## Testing your integration

- **Unit tests:** create the fleet with no URL and give it a fake executor (`local: { executors: { fake: async (spec, rt) => ({ exitCode: 0, outputs: [] }) } }`, `type: 'fake'`). No ffmpeg needed.
- **Integration tests:** real ffmpeg, no URL: generate fixtures with `-f lavfi -i testsrc`.
- **Fleet tests:** start an in-process worker/orchestrator on port 0 (`createWorker`, `createOrchestrator` from the packages; see `test/helpers/` and `test/e2e/` in this repository for real-process examples).

## Operational checklist for an app

- [ ] Own client id and secret, scope `jobs`; secret from the environment, not source control.
- [ ] Job ids derived from your entities and prefixed with your app name.
- [ ] `fallback` chosen deliberately (`local` if the app host can encode; `none` if falling back would overload it).
- [ ] Failure handling for `WORKER_LOST` / `ORCHESTRATOR_RESTARTED` (resubmit or surface).
- [ ] No long-lived secrets inside URIs or `ffmpeg.args` (job specs are stored and returned in snapshots).
- [ ] You never pass user-controlled text as ffmpeg *arguments* without validation: see [security.md](security.md#what-a-job-can-do).
