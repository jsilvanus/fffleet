# fffleet-worker

Runs ffmpeg jobs on one machine and serves the [fffleet](https://www.npmjs.com/package/fffleet) job API. It can be used on its own (clients point straight at it) or registered with an [orchestrator](https://www.npmjs.com/package/fffleet-orchestrator).

```sh
npx fffleet-worker                       # needs ffmpeg on PATH
docker run -p 5100:5100 -e FFFLEET_TOKEN=secret ghcr.io/jsilvanus/fffleet-worker
```

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `5100`, `0.0.0.0` | |
| `FFFLEET_TOKEN` | `FFFLEET_WORKER_TOKEN` | Bearer token callers must send (full access, and what the orchestrator uses). With neither set the API is open. |
| `FFFLEET_KEYS_URL` | the orchestrator's `/v1/auth/keys` when a token and an orchestrator are set | Also accept tokens the orchestrator issued, with their scopes. |
| `FFFLEET_SLOTS` | `default=2` | Slot pools, e.g. `default=2,stream=1`, or `auto` (from the CPU count) / `auto:4` (4 cores per slot). |
| `FFFLEET_KINDS` | `batch,stream` | Job kinds this worker takes. Others get 422 `UNSUPPORTED_KIND`, and the orchestrator does not send them. |
| `FFFLEET_CAPABILITIES` | | Extra capabilities, comma separated, e.g. `mount:/media,site:hel1`. |
| `FFFLEET_ORCHESTRATOR_URL` | | Register and heartbeat here. |
| `FFFLEET_WORKER_TOKEN` | | Token for the orchestrator. |
| `FFFLEET_ADVERTISE_URL` | listen URL | URL the orchestrator should call this worker on. |
| `FFFLEET_WORKER_ID` | `worker-<hostname>` | |
| `FFFLEET_HEARTBEAT_MS` | `5000` | |
| `FFFLEET_WORK_DIR` | `$TMPDIR/fffleet` | Scratch space for staged inputs and outputs. |
| `FFFLEET_CACHE_DIR` | | Keep staged `s3://` and `http(s)://` inputs here between jobs (hard-linked, checked against the object's ETag). Off when unset. |
| `FFFLEET_CACHE_MAX_SIZE` | `20GB` | Least recently used inputs are removed above this. |
| `FFMPEG_PATH` | `ffmpeg` | |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | | Enable `s3://` inputs and outputs and the `scheme:s3` capability. Also `AWS_SESSION_TOKEN`, `AWS_REGION`. |
| `FFFLEET_S3_ENDPOINT`, `FFFLEET_S3_PATH_STYLE` | AWS, off | For S3-compatible stores, e.g. `http://minio:9000` and `1`. |

The worker detects `type:ffmpeg`, `ffmpeg:<version>`, `filter:*`, `encoder:*` and `font:*` capabilities at start-up.

The Docker image is Debian's ffmpeg build, with x264, x265, vpx, aom, lame, opus, libass and freetype, plus DejaVu fonts.

Programmatic use: `import { createWorker } from 'fffleet-worker'`. Pass `executors` to add job types other than ffmpeg.

`GET /metrics` (Prometheus text format, `metrics` scope or the static token) reports slots, running jobs with their encoding speed and fps, ffmpeg CPU and memory, bytes staged and uploaded, and host load and memory.

License: EUPL-1.2
