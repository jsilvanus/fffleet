---
"fffleet": minor
"fffleet-worker": minor
"fffleet-orchestrator": minor
---

S3 storage: batch jobs can read inputs from and write outputs to `s3://bucket/key` URIs, including folder outputs (`s3://bucket/prefix/`) for multi-file results such as HLS. Workers with S3 credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `FFFLEET_S3_ENDPOINT`) report `scheme:s3`, and the orchestrator routes S3 jobs only to them. Large files are uploaded in parts. No new dependencies.
