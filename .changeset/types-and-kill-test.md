---
"fffleet": patch
---

Type fix: `parseSpec()` and the other places that return a `JobSpec` now have `kind`, `type`, `class` and the other filled-in fields typed properly (they came out as `unknown`). CI now compiles a small consumer against the declarations and checks they list every runtime export.
