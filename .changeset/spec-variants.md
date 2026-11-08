---
"fffleet": minor
"fffleet-worker": minor
"fffleet-orchestrator": minor
---

Job spec `variants`: one job can carry where-dependent versions of its `ffmpeg`, `inputs`, `outputs`, type section and `labels`, chosen by worker ID or capabilities after placement. The orchestrator (or a worker that gets the spec directly) applies the first fitting variant and reports it as `variant` on the job, its events and `job.variant` in the client. Additive to contract v1.
