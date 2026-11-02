# Worker roles for the church stack

Which machine runs which jobs. Config lives in `deploy/pi/` (`fffleet.yaml`, `worker.env.example`, `fffleet-worker.service`); nothing is installed by the repo.

| Worker ID | Machine | `FFFLEET_CAPABILITIES` | Slots | Why |
|---|---|---|---|---|
| `pi` | kirkonpi (Pi 4) | `usb,normal` | 2 | Only machine with the USB capture hardware (Hama, USB audio). Also the host of MediaMTX, so light relay jobs may run next to it. |
| `operator-pc` | Operator PC (Docker `fleet-worker`) | `normal,dsk,gpu` | by CPU (`auto`) | Strongest machine: DSK/graphics rendering, GPU or compute-heavy work, plus normal jobs. |
| `assisting-pc` | Assisting PC | `normal` | by CPU | Spare capacity for normal jobs. |

## What the capabilities mean

- `usb`: hardware that exists only on that host. A job that needs it says `requires: ["usb"]`; only the Pi advertises it, so nothing else can take it.
- `normal`: ordinary relay and MediaMTX-side ffmpeg work (fan-out, re-mux, one-shot frame grabs). Present on all three workers so the job survives any one machine being off. Stream callers add `requires: ["normal"]` (LCYT: `MEDIAMTX_FLEET_REQUIRES`).
- `dsk`: DSK rendering. It is the executor type (`type:dsk` is implicit), so it exists only on workers running the DSK image (operator PC). The `gpu` capability is for work that needs a graphics card or lots of compute.

Placement (`deploy/pi/fffleet.yaml`) then orders the workers: operator PC first, assisting PC next, the Pi last, so the Pi 4 keeps its CPU for MediaMTX and the gateway. If the first worker is off or full the next gets the job at once. Only `usb` jobs are pinned to the Pi.

## Checks and rollout

1. Tag-matched images: the `latest`/`2.7.0` ghcr worker, worker-ytdlp and orchestrator images were built from commit 874cb54 (release run 2026-11-01 11:34 UTC, all three image jobs green) and contain the `workerPreference` and `placement` code. `deploy/*` changes after that are not in the images (they are not needed there).
2. Pi: copy `fffleet.yaml`, restart the orchestrator, then install the worker from `worker.env.example` (`FFFLEET_WORKER_ID=pi`). Needs Juha's OK; do it in a Pi device thread, from main only.
3. Operator PC: set `FFFLEET_WORKER_ID=operator-pc`, `FFFLEET_CAPABILITIES=normal,dsk,gpu` on the Docker worker (currently registered as `operator-pc`), and `FFFLEET_ADVERTISE_URL` to the PC's LAN address.
4. Assisting PC: same pattern, ID `assisting-pc`, capabilities `normal`.
5. Verify: `curl http://192.168.1.78:5000/v1/workers` shows each ID with its capabilities; submit a `requires: ["usb"]` echo job and check `workerId` is `pi`.

## Direct ffmpeg use in the Pi repos

See the audit in the PR description; summary: `pimatrix` stream-supervisor already uses fffleet; `pimatrix` composite key-render/key-publisher, `pivoice` capture/radio, `pigraphics` still-renderer, `web-radio-relay` (VPS) still spawn ffmpeg themselves.
