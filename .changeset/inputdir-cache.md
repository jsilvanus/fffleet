---
"fffleet": minor
"fffleet-worker": minor
"fffleet-orchestrator": minor
---

`{{inputdir:name}}` placeholder: the directory a staged input sits in (each input now has its own), for options such as `ass=…:fontsdir=`. Workers can keep staged `s3://` and `http(s)://` inputs between jobs with `FFFLEET_CACHE_DIR` and `FFFLEET_CACHE_MAX_SIZE`: later jobs hard-link the cached file after checking its ETag, and the least recently used files are removed above the limit.
