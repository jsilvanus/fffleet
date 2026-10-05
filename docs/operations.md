# Running fffleet in production

One orchestrator, a pool of workers, apps that submit jobs. This page puts the settings from the READMEs in the order you need them. Every variable is described in the README of the package it belongs to.

## Shape of a deployment

```
apps ──(TLS, token)──▶ orchestrator ──(private network, worker token)──▶ workers ──▶ S3 / shared mount
                            │
                       /data volume: signing key, clients file, job state
```

- **One orchestrator per fleet.** It is the only place that holds the queue. Run a second one only as a cold standby on the same `/data`, never both at once.
- **One worker per machine**, sized with `slots`. More workers on one machine only to isolate jobs from each other.
- **Workers on a private network.** The orchestrator reaches them with the worker token, which grants admin on a worker.
- **The orchestrator behind TLS** (a reverse proxy) when apps or Prometheus reach it over anything you do not control. Tokens and secrets travel in headers.

## Step by step

1. **Secrets.** Choose a worker token (`FFFLEET_WORKER_TOKEN`) and keep it out of the apps. Apps get their own logins, not a shared secret.
2. **Persistent files.** Mount a volume at `/data` (the image creates it for the `node` user) and set:
   ```sh
   FFFLEET_SIGNING_KEY_FILE=/data/signing.pem   # created on first start; tokens survive restarts
   FFFLEET_CLIENTS_FILE=/data/clients.json      # the apps that may log in
   FFFLEET_STATE_FILE=/data/state.db            # queued and running jobs survive restarts (Node 22.13+; the image has it)
   ```
   The signing key also lets workers the autoscaler started before a restart rejoin. Back up `/data`: the key and the clients file are the only state that cannot be recreated.
3. **Add each app.** `npx fffleet-orchestrator add-client video-app --scope jobs` prints the secret once. Add a `metrics` client for Prometheus. Remove an app by deleting it from the clients file; its tokens stop working within a second.
4. **Start workers.** Set `FFFLEET_ORCHESTRATOR_URL`, `FFFLEET_WORKER_TOKEN`, a stable `FFFLEET_WORKER_ID`, `FFFLEET_ADVERTISE_URL` (how the orchestrator reaches the worker) and slots. `FFFLEET_CAPABILITIES=mount:/media` marks workers that share a mount, so jobs that need it `requires` it.
5. **Storage.** Give workers S3 credentials (`AWS_*`, `FFFLEET_S3_ENDPOINT` for S3-compatible stores) and use `s3://` inputs and outputs, so no worker needs the others' disks. Set `FFFLEET_CACHE_DIR` on workers that read the same large sources repeatedly.
6. **Autoscaling (optional).** Point `FFFLEET_CONFIG` at a pools file (see the README). Free capacity first, paid capacity last. Set `autoscale.joinSecret` or keep the signing key, and make the orchestrator reachable at `publicUrl` from new workers.
7. **Watch it.** Scrape the orchestrator and use `/v1/sd/prometheus` for the workers (README, "Metrics"). Alerts worth having:
   - `fffleet_queue_length` above zero for longer than a job should wait;
   - `increase(fffleet_workers_lost_total[10m]) > 0`;
   - `increase(fffleet_jobs_finished_total{state="failed"}[10m])` by `code`;
   - `up == 0` for a worker, and free work-directory space on workers.

## Restarts and upgrades

**Orchestrator restart.** With `FFFLEET_STATE_FILE` set:

| Job | After the restart |
|---|---|
| Queued | Back in the queue, same order and priority. |
| Running batch | Picked up again when its worker reports it in a heartbeat. If the worker does not within `FFFLEET_ADOPT_GRACE_MS` (30 s), the job fails with `ORCHESTRATOR_RESTARTED` and the app decides whether to submit it again. |
| Running stream | Fails with `ORCHESTRATOR_RESTARTED`: the app's connection to it is gone. |
| Finished | Kept for status and idempotency (the newest 1000). |

Without a state file the orchestrator forgets all of them; workers keep running theirs, but nobody is following them.

**Worker restart.** Its running jobs fail with `WORKER_LOST` once the orchestrator sees the heartbeat without them. Drain first for planned work: `POST /v1/workers/<id>/drain` (admin) stops new jobs going there; restart when its slots are empty.

**Upgrading.** The three packages are one version. Upgrade workers and orchestrator together (the contract is versioned, `v1`, and does not change inside a major version), apps whenever. See [upgrading.md](upgrading.md) for what changed between versions. A state file written by a newer version is refused rather than misread.

## When something is wrong

| You see | Usually |
|---|---|
| Job stays `queued` | No worker has a free slot in the job's class, the right `kind`, or every capability in `requires` (`GET /v1/workers`, `GET /v1/capabilities`). An `s3://` job needs a worker with S3 credentials. |
| `WORKER_LOST` | The worker missed its heartbeats (`FFFLEET_HEARTBEAT_TIMEOUT_MS`, 15 s), restarted, or lost the job. Check the worker's logs and the network between the two. |
| `DISPATCH_REJECTED` | The worker refused the spec (unknown job type, unsupported scheme, kind not accepted). The message says why. |
| `FFMPEG_EXIT` | ffmpeg itself failed. `stderrTail` on the job has its last lines. Running jobs show the newest lines as they appear (`job.on('stderr', ...)`, `stderrTail` in the snapshot), which helps with stream jobs that never exit. |
| `INPUT_FAILED`, `UPLOAD_FAILED`, `OUTPUT_MISSING` | Staging: the URL, credentials or disk space. |
| `ORCHESTRATOR_RESTARTED` | The orchestrator restarted while the job ran (see above). |
| `401` from apps | The token expired and the app does not log in again, the client was removed, or the signing key changed (no `FFFLEET_SIGNING_KEY_FILE`). |
| Workers started by the autoscaler cannot rejoin after a restart | No stable signing key or `autoscale.joinSecret`. |
| `a state file needs node:sqlite` | Node older than 22.13. Use the Docker image or upgrade Node. |

The orchestrator logs one line per join, loss, dispatch failure and restore, so start with its output.
