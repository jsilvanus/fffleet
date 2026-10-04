---
"fffleet": minor
"fffleet-worker": minor
"fffleet-orchestrator": minor
---

Apps log in to the orchestrator with their own client id and secret (`POST /v1/auth/token`, OAuth2 client credentials) and get short-lived signed tokens with `jobs`, `metrics` or `admin` scope. An app sees and cancels only its own jobs. `createFleet` takes `clientId` and `clientSecret` and refreshes the token itself; `fffleet-orchestrator add-client` creates apps. Workers accept the same tokens. The orchestrator and workers serve Prometheus metrics at `/metrics`, and the orchestrator lists its workers for Prometheus HTTP service discovery.
