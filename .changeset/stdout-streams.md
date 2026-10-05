---
"fffleet": minor
"fffleet-worker": minor
"fffleet-orchestrator": minor
---

Stream jobs can hand ffmpeg's stdout to the submitter (`stdout: true`, `job.stdout()`, `GET /v1/jobs/:id/stdout`, relayed by the orchestrator), for raw audio or video that a consumer processes as it arrives.
