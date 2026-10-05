# Install and use

A walk from "ffmpeg on my laptop" to "a pool of workers behind logins". Every step works on its own: stop wherever you have enough.

**Requirements:** Node.js 20 or newer on every machine that runs fffleet code, and `ffmpeg` (and `ffprobe`) on every machine that *runs jobs*. Docker is optional. The orchestrator's state file needs Node 22.13+ (the Docker images use Node 22).

## 1. Run jobs in your own process

```sh
npm install fffleet
```

```js
import { createFleet } from 'fffleet';

const fleet = createFleet();   // no url: jobs run on this machine

const job = await fleet.submit({
  kind: 'batch',
  inputs:  [{ name: 'src',   uri: 'file:///media/in.mp4' }],
  outputs: [{ name: 'thumb', uri: 'file:///media/thumb.jpg' }],
  ffmpeg:  { args: ['-ss', '5', '-i', '{{input:src}}', '-frames:v', '1', '{{output:thumb}}'] },
});

job.on('state', state => console.log(job.id, state));
const result = await job.done;                // never rejects because of ffmpeg
if (result.state !== 'succeeded') console.error(result.error, result.stderrTail);
await fleet.close();
```

What to know:

- `{{input:name}}` and `{{output:name}}` in `ffmpeg.args` are replaced by local paths (or by the URI itself for live schemes). `-y`, `-nostdin`, `-progress` and `-loglevel` are added for you. You never put `ffmpeg` itself in `args`.
- `job.done` resolves with the **final snapshot** whatever happened: check `state` (`succeeded`, `failed`, `cancelled`), `error` (`{ code, message }`), `exitCode` and `stderrTail`.
- Set `ffmpeg.durationMs` (the expected output length) to get `progress.pct`; without it `pct` is `null` and you still get `outTimeMs`, `speed`, `fps` and `frame`.
- Local concurrency is `local: { slots: { default: 2 } }` (or `'auto'`) on `createFleet`. Jobs beyond that wait in a priority queue.
- To inspect a file instead of transcoding it, submit `type: 'ffprobe'` with one input and no outputs; the JSON comes back inline in `result.outputs[0].data`.

## 2. Add a worker

A worker is a daemon around the same runner. Use one to move encoding off the application host.

```sh
# on the encoding machine (needs ffmpeg on PATH)
FFFLEET_TOKEN=change-me npx fffleet-worker
# or
docker run -p 5100:5100 -e FFFLEET_TOKEN=change-me ghcr.io/jsilvanus/fffleet-worker
```

```js
const fleet = createFleet({ url: 'http://encoder.internal:5100', token: 'change-me' });
```

Nothing else in the application changes. If the worker cannot be reached when a job is submitted, the job runs locally (`fallback: 'local'`, the default; use `fallback: 'none'` to get the error instead).

Shared files: `file:` URIs must name a path that exists **on the worker**. Either mount the same volume everywhere (and tell the scheduler with `FFFLEET_CAPABILITIES=mount:/media` plus `requires: ['mount:/media']` in jobs), or use `s3://` / `https://` endpoints, which the worker stages for you ([integration guide](integration-guide.md#getting-media-to-and-from-workers)).

> A worker started without a token accepts jobs from anyone who can reach its port. Always set one off localhost; see [security.md](security.md).

## 3. Add an orchestrator

With more than one worker, put an orchestrator in front. Apps talk to it exactly as they talked to a single worker.

```sh
# docker compose: an orchestrator on :5000 and two workers sharing ./media
FFFLEET_TOKEN=client-secret FFFLEET_WORKER_TOKEN=worker-secret docker compose up --build
```

Without Docker:

```sh
FFFLEET_TOKEN=client-secret FFFLEET_WORKER_TOKEN=worker-secret npx fffleet-orchestrator

FFFLEET_ORCHESTRATOR_URL=http://localhost:5000 FFFLEET_WORKER_TOKEN=worker-secret \
FFFLEET_ADVERTISE_URL=http://this-host:5101 PORT=5101 npx fffleet-worker
```

`FFFLEET_ADVERTISE_URL` is the address the **orchestrator** uses to call the worker back; set it whenever the worker is not on the orchestrator's own host. Check the result:

```sh
curl -H 'authorization: Bearer client-secret' http://localhost:5000/v1/capabilities
# { "role": "orchestrator", "workers": 2, "slots": { "default": { "total": 4, "used": 0 } }, ... }
```

Point the app at `http://localhost:5000` with the client token and you are done. The two tokens are deliberately different: **client token** for apps, **worker token** for workers (it grants admin on a worker, so keep it out of apps).

## 4. Give each app its own login

Instead of sharing one static token, each app gets a client id and secret and logs in for short-lived tokens.

```sh
export FFFLEET_CLIENTS_FILE=/data/clients.json FFFLEET_SIGNING_KEY_FILE=/data/signing.pem
npx fffleet-orchestrator add-client video-app --scope jobs   # prints the secret once
npx fffleet-orchestrator add-client prometheus --scope metrics
FFFLEET_WORKER_TOKEN=worker-secret npx fffleet-orchestrator
```

```js
const fleet = createFleet({
  url: process.env.FFFLEET_URL,
  clientId: 'video-app',
  clientSecret: process.env.FFFLEET_SECRET,
});
```

The client logs in on first use, reuses the token, refreshes it at 80 % of its lifetime and once more on a 401. Each app only sees its own jobs. To remove an app, delete it from the clients file: its tokens stop working within a second.

## 5. Keep jobs across orchestrator restarts

```sh
FFFLEET_STATE_FILE=/data/state.db   # Node 22.13+; the Docker image has it
```

Queued jobs come back; running batch jobs are picked up again when their worker reports them. See [operations.md](operations.md#restarts-and-upgrades).

## 6. Scale automatically

Give the orchestrator a pools file and it starts workers when jobs wait and removes them when idle:

```sh
FFFLEET_CONFIG=fffleet.yaml FFFLEET_TOKEN=c FFFLEET_WORKER_TOKEN=w npx fffleet-orchestrator
```

[`fffleet.example.yaml`](../fffleet.example.yaml) shows `process`, `docker` and `hetzner` pools. Order the pools cheapest first. Details and the Hetzner notes are in the [README](../README.md#autoscaling).

## 7. Watch it

```sh
curl -H 'authorization: Bearer metrics-token' http://localhost:5000/metrics
```

Scrape the orchestrator, and use `/v1/sd/prometheus` for the workers ([README, "Metrics"](../README.md#metrics)). Suggested alerts are in [operations.md](operations.md#step-by-step).

## Environment variable cheat sheet

| Where | Variable | Meaning |
|---|---|---|
| app | `FFFLEET_URL` | Your convention for the orchestrator or worker URL; pass it to `createFleet({ url })`. |
| orchestrator | `FFFLEET_TOKEN` | Static admin token (apps, scripts). |
| orchestrator | `FFFLEET_WORKER_TOKEN` | Token workers register with. **Set it** whenever any auth is on. |
| orchestrator | `FFFLEET_CLIENTS_FILE`, `FFFLEET_SIGNING_KEY_FILE` | App logins; the signing key keeps tokens valid across restarts. |
| orchestrator | `FFFLEET_STATE_FILE` | SQLite file for job persistence. |
| orchestrator | `FFFLEET_CONFIG` | Autoscaling pools (YAML or JSON). |
| worker | `FFFLEET_ORCHESTRATOR_URL`, `FFFLEET_ADVERTISE_URL`, `FFFLEET_WORKER_ID` | Register with an orchestrator; how it calls back; a stable name. |
| worker | `FFFLEET_SLOTS`, `FFFLEET_KINDS`, `FFFLEET_CAPABILITIES` | Concurrency, accepted job kinds, extra capabilities. |
| worker | `AWS_*`, `FFFLEET_S3_ENDPOINT`, `FFFLEET_CACHE_DIR` | S3 access and the input cache. |

Complete tables: [fffleet-worker](../packages/fffleet-worker/README.md) and [fffleet-orchestrator](../packages/fffleet-orchestrator/README.md).

## Troubleshooting first steps

- **Job stays `queued`:** `GET /v1/workers` (admin) and `GET /v1/capabilities`. No worker has a free slot in the job's class, the right `kind`, or every capability in `requires`.
- **Immediate `failed` with `FFMPEG_EXIT`:** read `result.stderrTail`; it is ffmpeg's own message.
- **`INPUT_FAILED` for a `file:` input:** the path is checked on the *worker*, not in your app.
- **Everything runs locally though `FFFLEET_URL` is set:** the fleet was unreachable or answered 502/503, and `fallback: 'local'` quietly took over. Use `fallback: 'none'` while setting up.

More in [operations.md](operations.md#when-something-is-wrong).
