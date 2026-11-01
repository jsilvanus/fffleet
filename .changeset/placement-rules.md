---
"fffleet-orchestrator": minor
---

Add `placement` rules to the config file: an ordered worker preference per job type, kind, class or required capability, with an optional `others` fallback. The config may now have no pools. Adds a systemd unit and docs for running the orchestrator on a Raspberry Pi.
