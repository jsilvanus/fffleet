# fffleet-orchestrator

One [fffleet](https://www.npmjs.com/package/fffleet) job API in front of many [workers](https://www.npmjs.com/package/fffleet-worker).

- Jobs wait in a priority queue. Each one goes to the least loaded worker that has a free slot in the job's class and every capability the job `requires`.
- The orchestrator relays that worker's events to clients.
- Jobs on a worker that stops sending heartbeats fail with `WORKER_LOST`.

```sh
FFFLEET_TOKEN=client-secret FFFLEET_WORKER_TOKEN=worker-secret npx fffleet-orchestrator
docker run -p 5000:5000 -e FFFLEET_TOKEN=... -e FFFLEET_WORKER_TOKEN=... ghcr.io/jsilvanus/fffleet-orchestrator
```

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `5000`, `0.0.0.0` | |
| `FFFLEET_TOKEN` | | A static token with full access. |
| `FFFLEET_CLIENTS_FILE` | | Apps that may log in (`POST /v1/auth/token`). Add one with `fffleet-orchestrator add-client <id> --scope jobs`. |
| `FFFLEET_SIGNING_KEY_FILE` | | Ed25519 key for tokens, created when missing. Without it tokens end at a restart. |
| `FFFLEET_TOKEN_TTL_SECONDS` | `3600` | |
| `FFFLEET_WORKER_TOKEN` | | Token workers register with. The orchestrator also sends it when it calls workers. |
| `FFFLEET_HEARTBEAT_TIMEOUT_MS` | `15000` | |
| `FFFLEET_MAX_QUEUED` | `1000` | Above this, submissions get 503. |

Extra routes: `GET /v1/workers` lists the pool. `POST /v1/workers/:id/drain` stops new work going to a worker, for example before you shut it down (both need `admin`). `GET /metrics` is the fleet view for Prometheus, and `GET /v1/sd/prometheus` lists the workers as scrape targets. Logins, scopes and per-app job ownership are described in the [main README](https://github.com/jsilvanus/fffleet#logins-many-apps-one-orchestrator). With neither `FFFLEET_TOKEN` nor a clients file the API is open, and the orchestrator says so at startup.

State is kept in memory: a restart forgets the queue.

License: EUPL-1.2
