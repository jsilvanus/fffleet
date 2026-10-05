---
"fffleet": patch
"fffleet-worker": patch
"fffleet-orchestrator": patch
---

Review fixes and documentation.

- The client reports a proxy's non-JSON error page by its HTTP status instead of failing with a JSON parse error; a 401 no longer looks like an unreachable fleet.
- The orchestrator rejects worker registrations whose `url` is not an http(s) URL (one bad registration used to break `/v1/sd/prometheus` for everyone), and releases the response of accepted dispatches.
- `{{inputdir:name}}` on an input without a directory (a live URL) now fails the job with `INVALID_SPEC` instead of `INTERNAL`.
- `add-client` writes the clients file atomically.
- The orchestrator warns when authentication is on but `FFFLEET_WORKER_TOKEN` is not set (worker registration is then open), and the worker warns when it is open on a non-loopback address.
- New docs: architecture, install and use, integration guide, security.
