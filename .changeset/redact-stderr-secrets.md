---
"fffleet": minor
---

Job specs accept `redact: string[]`: each listed secret value is replaced by `***` in stderr tails and job events. Optional and additive, so contract v1 is unchanged.
