# Security

What fffleet protects, what it deliberately does not, and how to deploy it safely. Read this before exposing an orchestrator or a worker beyond localhost.

## Trust model in one paragraph

**Whoever can submit a job is trusted to run `ffmpeg` with arbitrary arguments as the worker's operating-system user.** fffleet authenticates *who* may submit and keeps apps from seeing each other's jobs; it does not sandbox ffmpeg. Treat the `jobs` scope like shell access to the worker for ffmpeg-shaped commands, and give workers only the privileges and network reach you are willing to give those apps.

## What a job can do

Because `ffmpeg.args` and the endpoint URIs come from the submitter:

- `file:` inputs and outputs, and any path in the arguments, are read and written **as the worker user** (`mkdir -p` is done for `file:` outputs). A job can overwrite any file that user can write and read any file it can read.
- `http(s):` inputs are fetched by the worker, which can reach the worker's network: internal services, cloud metadata (`169.254.169.254`) and so on (server-side request forgery from the submitter's point of view). Redirects are followed.
- ffmpeg can open playlists, concat lists, subtitle files and `http` sources that reference further URLs or local files. fffleet does not add `-protocol_whitelist`.
- The `ffprobe` job type reads the same way.
- Custom executors (`FFFLEET_EXECUTORS`) are code loaded into the worker.

None of this is a bug; it is the contract. It means:

1. **Never build `ffmpeg.args` or URIs from untrusted text** (user uploads' file names, form fields) without validating them in your application. Prefer fixed argument templates and pass only validated values (numbers, enumerated names).
2. **Run workers as an unprivileged user, preferably in a container** with only the media it needs mounted (the supplied image runs as `node`), no host mounts of credentials, and no access to the metadata service or internal networks it does not need.
3. **One fleet per trust level.** Do not share workers between an app you trust and one whose job specs you do not control.

## Authentication

| Surface | Open by default? | How to close it |
|---|---|---|
| Worker API | **Yes**, when neither `FFFLEET_TOKEN` nor `FFFLEET_WORKER_TOKEN` is set. | Set a token. The worker logs a warning when open and listening beyond loopback. |
| Orchestrator job API | **Yes**, when neither `FFFLEET_TOKEN` nor a clients file is set (it logs this). | Set `FFFLEET_TOKEN` and/or `FFFLEET_CLIENTS_FILE`. |
| `POST /v1/workers/register` | **Yes**, when `FFFLEET_WORKER_TOKEN` is not set, *even if the job API is protected*. Anyone who can reach the orchestrator could then register a worker and be sent jobs (and the specs in them). | Always set `FFFLEET_WORKER_TOKEN`. The orchestrator logs a warning when auth is on and the worker token is missing. |
| `GET /v1/health`, `GET /v1/auth/keys` | Yes, by design (no secrets). | n/a |

The defaults bind `0.0.0.0` so containers work. Outside containers, set `HOST=127.0.0.1` (or a private interface) unless you mean to expose the port.

### Tokens and secrets

- App secrets are 256-bit random values stored only as scrypt hashes (`clients.json`, mode 0600). `add-client` prints the secret once; it cannot be recovered, only replaced (`add-client` again with the same id).
- Access tokens are Ed25519-signed JWTs, one hour by default. Removing a client deletes its access within a second (the clients file is re-read and `sub` is checked on every request). Protect and back up the signing key file: anyone holding it can mint admin tokens. Rotate by replacing the file and restarting; all tokens and (without `autoscale.joinSecret`) all autoscaled workers' join secrets change with it.
- The **worker token** grants admin on workers. It is held by the orchestrator and by workers, never by apps.
- Autoscaled workers get their own join secrets, not the worker token.
- Comparison of static tokens is constant-time up to length.

### Isolation between apps

An app with the `jobs` scope can list, read, follow, cancel, write to and read from the stdin/stdout of **its own** jobs only; another app's job answers 404 (the same as a missing job). `admin` and the static token see everything. Caveat: job ids are one namespace, so submitting an id another app already used answers 409 (which reveals that the id exists). Prefix ids with the app name.

### Transport

Tokens and client secrets travel in HTTP headers/bodies. fffleet serves plain HTTP: terminate TLS in front of the orchestrator (Caddy, nginx, Traefik) whenever the path between apps and orchestrator is not a network you fully control. Keep orchestrator-to-worker traffic on a private network (it carries the worker token and job specs). Ordinary reverse proxies work; disable response buffering for `/v1/jobs/:id/events` and `/stdout` (the servers send `x-accel-buffering: no`).

## Data at rest

- Job specs and results are stored in the orchestrator's SQLite file (`FFFLEET_STATE_FILE`) and returned in snapshots: input/output URIs, arguments, labels, ffmpeg stderr tails. **Do not put long-lived credentials in URIs or arguments**; use presigned URLs with short expiry or worker-held S3 credentials.
- The Hetzner provider writes the worker's environment (including S3 keys from `pool.env` and the join secret) into the server's cloud-init `user_data`, which is readable through the Hetzner API with your project token and from inside the VM via the metadata service. Use scoped, rotatable S3 keys for autoscaled workers.
- The input cache (`FFFLEET_CACHE_DIR`) keeps downloaded media on the worker, keyed by URI, and is shared by all jobs on that worker.

## Autoscaling privileges

- The `docker` provider needs the Docker Engine socket, which is root-equivalent on that host. Prefer a socket proxy limited to container create/start/delete/list, or run the orchestrator on a dedicated host.
- The `process` provider starts workers as the orchestrator's user and passes them the orchestrator's environment except `FFFLEET_*` (so `AWS_*` and similar are inherited by those workers).
- Restrict the worker port on cloud servers with a firewall (`hetzner.firewalls`) to the orchestrator's address and your Prometheus.

## Hardening checklist

- [ ] Tokens set on **both** the job API and worker registration (`FFFLEET_WORKER_TOKEN`).
- [ ] Orchestrator behind TLS; workers on a private network, not published to the internet.
- [ ] A login (`add-client`) per app, minimum scope; the static token kept for operators.
- [ ] `FFFLEET_SIGNING_KEY_FILE` on a persistent, backed-up volume with tight permissions.
- [ ] Workers unprivileged, containerised, with minimal mounts and egress.
- [ ] Rate-limit `POST /v1/auth/token` at the proxy (each attempt costs a scrypt hash, so floods can occupy the thread pool).
- [ ] Application validates everything it interpolates into specs.
- [ ] Alerts on `fffleet_auth_login_failures_total` and unexpected `fffleet_workers`.

## Known limitations

These came out of the 2026-10 code review. They are documented rather than changed because they alter behaviour or need design decisions.

1. **No sandbox or path allow-list for `file:` and ffmpeg arguments** (see above). A configurable allow-list of `file:` roots would help for well-behaved clients but cannot contain arbitrary `ffmpeg.args`.
2. **Local fallback after an ambiguous failure can run a job twice.** If the remote accepted the job but the response was lost (timeout, connection reset), the client treats it as unreachable and runs the job locally while the remote may also run it. Idempotency protects a *retry against the fleet*, not a fallback. Use `fallback: 'none'` for jobs with side effects that must not repeat, or make outputs idempotent.
3. **Job ids are a single namespace** across apps (409 reveals existence). Prefix ids.
4. **No login rate limiting** in the orchestrator itself.
5. **A client that disconnects from an orchestrator-relayed `/stdout`** stops the relay but leaves the worker-side reader attached, so ffmpeg stalls until the job is cancelled or times out. Cancel the job when you abandon its stdout.
6. **Presigned URLs and arguments are persisted** in the state file and returned to the owner and admins.
7. **`add-client` is a local file operation**: run it on the host that has the clients file; the orchestrator picks changes up within a second. It is not an API.
8. **Join secrets derive from the signing key file's bytes** when `autoscale.joinSecret` is not set (one key serving two purposes). Set `autoscale.joinSecret` explicitly to decouple them.

Report vulnerabilities privately through GitHub's "Report a vulnerability" on the repository's Security tab.
