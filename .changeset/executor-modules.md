---
"fffleet": patch
"fffleet-worker": minor
"fffleet-orchestrator": patch
---

`fffleet-worker` loads extra job types from modules listed in `FFFLEET_EXECUTORS`, so jobs that are not ffmpeg (a poller, an analyser) can run on the fleet and be routed by `type:<type>`.
