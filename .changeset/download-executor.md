---
"fffleet-worker": minor
"fffleet": minor
---

Add a built-in `download` executor (yt-dlp) to `fffleet-worker`, exported as `fffleet-worker/executors/download`, and a `ghcr.io/jsilvanus/fffleet-worker-ytdlp` image that has it enabled. The job takes `spec.download = { url, format?, extraArgs? }`, an optional `cookies` input (Netscape cookies.txt, copied into the work dir) and writes a `video` output (and `cookies-out` when yt-dlp changed the cookies). Cookie contents never reach logs or errors.
