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
| `FFFLEET_PROBE` | | Hosts to test with a TCP connect, comma separated `[alias=]host:port`, e.g. `mediamtx=10.1.2.3:8554,db.internal:5432`. While one connects the worker advertises `net:<host>:<port>`, plus `net:<alias>` (or `net:<host>` for a host name without alias). A job with `requires: ['net:mediamtx']` then only runs where that host is reachable, and a worker that loses it drops out of scheduling by itself. |
| `FFFLEET_PROBE_INTERVAL_MS` | `30000` | How often the probes run. |
| `FFFLEET_ORCHESTRATOR_URL` | | Register and heartbeat here. |
| `FFFLEET_WORKER_TOKEN` | | Token for the orchestrator. |
| `FFFLEET_ADVERTISE_URL` | listen URL | URL the orchestrator should call this worker on. |
| `FFFLEET_WORKER_ID` | `worker-<hostname>` | |
| `FFFLEET_HEARTBEAT_MS` | `5000` | |
| `FFFLEET_WORK_DIR` | `$TMPDIR/fffleet` | Scratch space for staged inputs and outputs. |
| `FFFLEET_CACHE_DIR` | | Keep staged `s3://` and `http(s)://` inputs here between jobs (hard-linked, checked against the object's ETag). Off when unset. |
| `FFFLEET_EXECUTORS` | | Comma-separated modules (package names or paths) that add job types. Each default-exports `{ type, run(spec, runtime) }` or an array of them. The worker then claims `type:<type>`. |
| `FFFLEET_CACHE_MAX_SIZE` | `20GB` | Least recently used inputs are removed above this. |
| `FFMPEG_PATH` | `ffmpeg` | |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | | Enable `s3://` inputs and outputs and the `scheme:s3` capability. Also `AWS_SESSION_TOKEN`, `AWS_REGION`. |
| `FFFLEET_S3_ENDPOINT`, `FFFLEET_S3_PATH_STYLE` | AWS, off | For S3-compatible stores, e.g. `http://minio:9000` and `1`. |

The worker detects `type:ffmpeg`, `ffmpeg:<version>`, `filter:*`, `encoder:*` and `font:*` capabilities at start-up.

The Docker image is Debian's ffmpeg build, with x264, x265, vpx, aom, lame, opus, libass and freetype, plus DejaVu fonts.

## Download jobs (yt-dlp)

`FFFLEET_EXECUTORS=fffleet-worker/executors/download` (or the `fffleet-worker-ytdlp` image, which has it and yt-dlp) adds job type `download`; the worker then claims `type:download`. `YTDLP_PATH` overrides the yt-dlp binary.

```js
{ type: 'download',
  download: { url: 'https://…', format: 'bv*+ba/b', extraArgs: ['--limit-rate', '5M'] },  // url must be http(s)
  inputs:  [{ name: 'cookies', uri: 's3://bucket/tmp/cookies.txt' }],   // optional Netscape cookies.txt
  outputs: [{ name: 'video', uri: 's3://bucket/out/video.mp4' },
            { name: 'cookies-out', uri: 's3://bucket/tmp/cookies-out.txt' }] }  // optional
```

**Credentials are a cookies.txt passed as an input**, so they travel like any other file (`s3:`, `http(s):` or `file:`) and never appear in the job spec, logs or errors. Stage the cookie file in a private object, and delete it when the job ends. yt-dlp rewrites its cookie file, so the executor works on a copy in the job's work directory; `cookies-out` is uploaded only when yt-dlp changed it, so you can store the refreshed cookies. `extraArgs` refuses options that run commands or touch other files (`--exec`, `--output`, `--cookies`, config and plugin options). Progress comes from yt-dlp's percentages and cancelling the job stops yt-dlp.

Programmatic use: `import { createWorker } from 'fffleet-worker'`. Pass `executors` to add job types other than ffmpeg.

`GET /metrics` (Prometheus text format, `metrics` scope or the static token) reports slots, running jobs with their encoding speed and fps, ffmpeg CPU and memory, bytes staged and uploaded, and host load and memory.

See also the [install and use guide](https://github.com/jsilvanus/fffleet/blob/main/docs/getting-started.md) and [security notes](https://github.com/jsilvanus/fffleet/blob/main/docs/security.md).

License: EUPL-1.2
