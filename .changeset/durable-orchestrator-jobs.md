---
"fffleet-orchestrator": minor
"fffleet": minor
---

The orchestrator can keep its jobs across restarts: set `FFFLEET_STATE_FILE` (or `stateFile`) to a SQLite file (needs Node 22.13 or later; without it nothing changes). Queued jobs go back in the queue in their old order, running batch jobs are picked up again when their worker reports them (or fail with `ORCHESTRATOR_RESTARTED` after `FFFLEET_ADOPT_GRACE_MS`), stream jobs fail with the same code, and finished jobs stay available for status and idempotency. `createOrchestrator` also takes a `store` of your own. New `JobRecord.restore()` in `fffleet`.
