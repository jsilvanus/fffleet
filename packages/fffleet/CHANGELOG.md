# fffleet

## 1.0.0

### Minor Changes

- 560a91f: Autoscaling. The orchestrator reads a YAML (or JSON) config of pools and starts workers when jobs wait, as child processes, Docker containers or Hetzner Cloud servers, and removes them when idle (Hetzner servers near the end of their paid hour). Workers get their own join secrets, and a restarted orchestrator adopts the servers it finds by label. New `GET /v1/pools` and `fffleet_autoscaler_*` metrics.

  Workers can take `slots: auto` (sized from the CPU count; `auto:N` for N cores per slot) and a `kinds` setting (`batch`, `stream`, or both). The orchestrator routes each job to a worker of its kind, and a worker refuses other kinds with 422 `UNSUPPORTED_KIND`.

- 1d3f31c: `{{inputdir:name}}` placeholder: the directory a staged input sits in (each input now has its own), for options such as `ass=…:fontsdir=`. Workers can keep staged `s3://` and `http(s)://` inputs between jobs with `FFFLEET_CACHE_DIR` and `FFFLEET_CACHE_MAX_SIZE`: later jobs hard-link the cached file after checking its ETag, and the least recently used files are removed above the limit.
- 2c95dc2: Apps log in to the orchestrator with their own client id and secret (`POST /v1/auth/token`, OAuth2 client credentials) and get short-lived signed tokens with `jobs`, `metrics` or `admin` scope. An app sees and cancels only its own jobs. `createFleet` takes `clientId` and `clientSecret` and refreshes the token itself; `fffleet-orchestrator add-client` creates apps. Workers accept the same tokens. The orchestrator and workers serve Prometheus metrics at `/metrics`, and the orchestrator lists its workers for Prometheus HTTP service discovery.
- d64c321: S3 storage: batch jobs can read inputs from and write outputs to `s3://bucket/key` URIs, including folder outputs (`s3://bucket/prefix/`) for multi-file results such as HLS. Workers with S3 credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `FFFLEET_S3_ENDPOINT`) report `scheme:s3`, and the orchestrator routes S3 jobs only to them. Large files are uploaded in parts. No new dependencies.

## 0.1.0

### Minor Changes

- 3132e01: First release: job contract v1, the client with local fallback, the worker daemon and the orchestrator.
