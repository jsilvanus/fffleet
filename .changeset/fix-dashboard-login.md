---
"fffleet-orchestrator": patch
---

Fix the dashboard login form: it threw "Cannot read properties of null (reading 'reset')" after a successful login, so the dashboard did not open.
