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
| `FFFLEET_STATE_FILE` | | SQLite file that keeps jobs across restarts (needs Node 22.13 or later; the Docker image has it). Without it a restart forgets the queue. |
| `FFFLEET_ADOPT_GRACE_MS` | `30000` | After a restart, how long a running job waits for its worker to report it before it fails with `ORCHESTRATOR_RESTARTED`. |
| `FFFLEET_CONFIG` | | YAML or JSON file with autoscaling pools (also `--config <file>`). See the [main README](https://github.com/jsilvanus/fffleet#autoscaling). |

Extra routes: `GET /v1/pools` lists the autoscaling pools. `GET /v1/workers` lists the pool. `POST /v1/workers/:id/drain` stops new work going to a worker, for example before you shut it down (both need `admin`). `GET /metrics` is the fleet view for Prometheus, and `GET /v1/sd/prometheus` lists the workers as scrape targets. Logins, scopes and per-app job ownership are described in the [main README](https://github.com/jsilvanus/fffleet#logins-many-apps-one-orchestrator). With neither `FFFLEET_TOKEN` nor a clients file the API is open, and the orchestrator says so at startup.

**Restarts.** Without `FFFLEET_STATE_FILE` the orchestrator keeps jobs in memory and a restart forgets them (workers keep running theirs). With it, jobs are saved as they change and come back after a restart:

- queued jobs go back in the queue, in the same order;
- running batch jobs are picked up again when their worker reports them in its next heartbeat; if it does not within `FFFLEET_ADOPT_GRACE_MS` (or finished while the orchestrator was down), the job fails with `ORCHESTRATOR_RESTARTED` and the client decides whether to submit it again (outputs may be half written, so jobs are not rerun for you);
- stream jobs fail with `ORCHESTRATOR_RESTARTED`, because the client's connection to them is gone;
- finished jobs stay available for status and idempotency, up to the newest 1000.

Keep the file on a volume that survives the container. Use one orchestrator per state file.

See also the [install and use guide](https://github.com/jsilvanus/fffleet/blob/main/docs/getting-started.md), the [architecture](https://github.com/jsilvanus/fffleet/blob/main/docs/architecture.md) and [security notes](https://github.com/jsilvanus/fffleet/blob/main/docs/security.md).

License: EUPL-1.2
