---
"fffleet": minor
"fffleet-worker": minor
"fffleet-orchestrator": minor
---

Built-in `ffprobe` job type: probes one `file:`, `http(s):` or `s3:` input and returns ffprobe's JSON inline in the job result (`outputs[].data`, `uri: 'inline:'`). Workers advertise `type:ffprobe` when ffprobe is installed. `OutputResult` gained an optional `data` field.
