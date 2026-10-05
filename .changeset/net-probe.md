---
"fffleet": minor
"fffleet-worker": minor
"fffleet-orchestrator": minor
---

Reachability probes. A worker started with `FFFLEET_PROBE=[alias=]host:port,...` tries a TCP connect to each host at start and every `FFFLEET_PROBE_INTERVAL_MS` (30 s) and advertises `net:<host>:<port>` (plus `net:<alias>`, or `net:<host>` for a host name) only while it connects. A job with `requires: ['net:mediamtx']` therefore runs only on workers that can reach that host, and a worker that loses it stops getting such jobs. New exports `parseProbes`, `probeCapabilities` and `canConnect`.
