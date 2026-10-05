---
"fffleet": minor
"fffleet-orchestrator": minor
---

Running jobs report the newest stderr lines while they run: `job.on('stderr', ...)`, `job.stderrTail` and `stderrTail` in the snapshot of a running job, relayed by the orchestrator, so a stream job that never exits can still be diagnosed. Executors can feed it with `runtime.stderr(tail)`.

`fffleet-orchestrator` no longer declares `fffleet-worker` as an optional peer dependency: it made Changesets turn every minor release into a major one (1.x went to 2.0.0 that way). The `process` autoscaling provider still needs `npm install fffleet-worker` or a `command`. New docs: `docs/operations.md` and `docs/upgrading.md`.
