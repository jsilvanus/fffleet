---
"fffleet": minor
"fffleet-worker": minor
"fffleet-orchestrator": minor
---

Autoscaling. The orchestrator reads a YAML (or JSON) config of pools and starts workers when jobs wait, as child processes, Docker containers or Hetzner Cloud servers, and removes them when idle (Hetzner servers near the end of their paid hour). Workers get their own join secrets, and a restarted orchestrator adopts the servers it finds by label. New `GET /v1/pools` and `fffleet_autoscaler_*` metrics.

Workers can take `slots: auto` (sized from the CPU count; `auto:N` for N cores per slot) and a `kinds` setting (`batch`, `stream`, or both). The orchestrator routes each job to a worker of its kind, and a worker refuses other kinds with 422 `UNSUPPORTED_KIND`.
