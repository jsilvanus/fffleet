# Upgrading

The three packages (`fffleet`, `fffleet-worker`, `fffleet-orchestrator`) share one version. The job contract is `v1` throughout; a change to it would be a new contract version, not a new package version.

## 1.x to 2.0

**Nothing that worked on 1.x stops working on 2.0.** The jump to 2.0 came from the release tooling, not from a breaking change: the optional `fffleet-worker` peer dependency of the orchestrator made Changesets raise a minor release to a major one. That peer dependency is gone from 2.1 on, so later minor releases stay minor.

What 2.0 added, all opt-in:

- Stream jobs can hand ffmpeg's stdout to the submitter (`stdout: true`, `job.stdout()`, `GET /v1/jobs/:id/stdout`), and `job.endStdin()` (`POST /v1/jobs/:id/stdin/close`) sends EOF to a job's stdin.
- Workers load extra job types from modules listed in `FFFLEET_EXECUTORS`; jobs are routed by `type:<type>`.

## 2.0 to 2.1

- The orchestrator can keep its jobs in a SQLite file (`FFFLEET_STATE_FILE`, Node 22.13 or later) and picks them up again after a restart. Without the variable nothing changes. See [operations.md](operations.md#restarts-and-upgrades).
- Running jobs report the newest stderr lines while they run: `job.on('stderr', ...)`, `job.stderrTail`, and `stderrTail` in the snapshot of a running job. Executors can call `runtime.stderr(tail)` to feed it. Final snapshots are unchanged.
- `fffleet-orchestrator` no longer lists `fffleet-worker` as an optional peer dependency. The `process` autoscaling provider still needs the worker package: `npm install fffleet-worker` beside the orchestrator, or set `process.command`.

## 0.1 to 1.0

Added autoscaling, `slots: auto`, worker kinds, per-app logins, S3 storage, Prometheus metrics, `{{inputdir:name}}` and the worker input cache. Without a clients file the static `FFFLEET_TOKEN` works as before.
