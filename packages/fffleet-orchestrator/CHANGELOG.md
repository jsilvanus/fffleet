# fffleet-orchestrator

## 2.1.1

### Patch Changes

- Updated dependencies [4188305]
  - fffleet@2.1.1

## 2.1.0

### Minor Changes

- 195a913: The orchestrator can keep its jobs across restarts: set `FFFLEET_STATE_FILE` (or `stateFile`) to a SQLite file (needs Node 22.13 or later; without it nothing changes). Queued jobs go back in the queue in their old order, running batch jobs are picked up again when their worker reports them (or fail with `ORCHESTRATOR_RESTARTED` after `FFFLEET_ADOPT_GRACE_MS`), stream jobs fail with the same code, and finished jobs stay available for status and idempotency. `createOrchestrator` also takes a `store` of your own. New `JobRecord.restore()` in `fffleet`.
- 6a98a72: Running jobs report the newest stderr lines while they run: `job.on('stderr', ...)`, `job.stderrTail` and `stderrTail` in the snapshot of a running job, relayed by the orchestrator, so a stream job that never exits can still be diagnosed. Executors can feed it with `runtime.stderr(tail)`.

  `fffleet-orchestrator` no longer declares `fffleet-worker` as an optional peer dependency: it made Changesets turn every minor release into a major one (1.x went to 2.0.0 that way). The `process` autoscaling provider still needs `npm install fffleet-worker` or a `command`. New docs: `docs/operations.md` and `docs/upgrading.md`.

### Patch Changes

- Updated dependencies [195a913]
- Updated dependencies [6a98a72]
- Updated dependencies [6a98a72]
  - fffleet@2.1.0

## 2.0.0

### Minor Changes

- 68b25ac: Stream jobs can hand ffmpeg's stdout to the submitter (`stdout: true`, `job.stdout()`, `GET /v1/jobs/:id/stdout`, relayed by the orchestrator), for raw audio or video that a consumer processes as it arrives. `job.endStdin()` (`POST /v1/jobs/:id/stdin/close`) sends EOF to a job's stdin.

### Patch Changes

- 6743a03: `fffleet-worker` loads extra job types from modules listed in `FFFLEET_EXECUTORS`, so jobs that are not ffmpeg (a poller, an analyser) can run on the fleet and be routed by `type:<type>`.
- Updated dependencies [6743a03]
- Updated dependencies [68b25ac]
  - fffleet@2.0.0
  - fffleet-worker@2.0.0

## 1.0.0

### Minor Changes

- 560a91f: Autoscaling. The orchestrator reads a YAML (or JSON) config of pools and starts workers when jobs wait, as child processes, Docker containers or Hetzner Cloud servers, and removes them when idle (Hetzner servers near the end of their paid hour). Workers get their own join secrets, and a restarted orchestrator adopts the servers it finds by label. New `GET /v1/pools` and `fffleet_autoscaler_*` metrics.

  Workers can take `slots: auto` (sized from the CPU count; `auto:N` for N cores per slot) and a `kinds` setting (`batch`, `stream`, or both). The orchestrator routes each job to a worker of its kind, and a worker refuses other kinds with 422 `UNSUPPORTED_KIND`.

- 1d3f31c: `{{inputdir:name}}` placeholder: the directory a staged input sits in (each input now has its own), for options such as `ass=…:fontsdir=`. Workers can keep staged `s3://` and `http(s)://` inputs between jobs with `FFFLEET_CACHE_DIR` and `FFFLEET_CACHE_MAX_SIZE`: later jobs hard-link the cached file after checking its ETag, and the least recently used files are removed above the limit.
- 2c95dc2: Apps log in to the orchestrator with their own client id and secret (`POST /v1/auth/token`, OAuth2 client credentials) and get short-lived signed tokens with `jobs`, `metrics` or `admin` scope. An app sees and cancels only its own jobs. `createFleet` takes `clientId` and `clientSecret` and refreshes the token itself; `fffleet-orchestrator add-client` creates apps. Workers accept the same tokens. The orchestrator and workers serve Prometheus metrics at `/metrics`, and the orchestrator lists its workers for Prometheus HTTP service discovery.
- d64c321: S3 storage: batch jobs can read inputs from and write outputs to `s3://bucket/key` URIs, including folder outputs (`s3://bucket/prefix/`) for multi-file results such as HLS. Workers with S3 credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `FFFLEET_S3_ENDPOINT`) report `scheme:s3`, and the orchestrator routes S3 jobs only to them. Large files are uploaded in parts. No new dependencies.

### Patch Changes

- Updated dependencies [560a91f]
- Updated dependencies [1d3f31c]
- Updated dependencies [2c95dc2]
- Updated dependencies [d64c321]
  - fffleet@1.0.0
  - fffleet-worker@1.0.0

## 0.1.0

### Minor Changes

- 3132e01: First release: job contract v1, the client with local fallback, the worker daemon and the orchestrator.

### Patch Changes

- Updated dependencies [3132e01]
  - fffleet@0.1.0
