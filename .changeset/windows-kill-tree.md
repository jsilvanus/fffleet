---
"fffleet": patch
---

Windows: cancelling a job ends ffmpeg's whole process tree (`taskkill /T /F`). With ffmpeg started through a launcher shim (Chocolatey, Scoop) the old kill stopped only the shim, ffmpeg kept running with its pipes open, and the job never ended.
