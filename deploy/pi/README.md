# fffleet orchestrator on the Pi (kirkonpi)

One orchestrator for the whole fleet runs on the Pi (Pi 4, Debian 13, Node 24 in `~/.local/bin` (kirkonpi) or `~/.local/node/bin`). Workers on the
assisting PC, the operator PC and the Pi itself register with it; apps (LCYT, Saarnavideo) send jobs to
`http://192.168.1.78:5000` (the Pi's planned wired address). Nothing here is deployed by the repo: copy the files by hand.

## Install

```sh
mkdir -p ~/apps/fffleet-orchestrator && cd ~/apps/fffleet-orchestrator
export PATH=$HOME/.local/bin:$HOME/.local/node/bin:$PATH
npm init -y >/dev/null && npm install fffleet-orchestrator     # pin a version if you like
cp <repo>/deploy/pi/fffleet.yaml .
cp <repo>/deploy/pi/orchestrator.env.example orchestrator.env && chmod 600 orchestrator.env   # set the two tokens
mkdir -p ~/.config/systemd/user && cp <repo>/deploy/pi/fffleet-orchestrator.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now fffleet-orchestrator
sudo loginctl enable-linger pi          # start at boot without a login
journalctl --user -u fffleet-orchestrator -f
curl http://127.0.0.1:5000/v1/health
```

The Pi also runs its own worker (`fffleet-worker`, same pattern, `FFFLEET_WORKER_ID=pi`,
`FFFLEET_ORCHESTRATOR_URL=http://127.0.0.1:5000`, `FFFLEET_WORKER_TOKEN` as in the env file). Keep its slots low on a Pi 4.

## Worker priority (placement)

`placement` in `fffleet.yaml` is an ordered list of rules. The first rule whose `match` fits a job decides which workers
may run it, most preferred first:

```yaml
placement:
  - match: { type: dsk }                 # match any of: type, kind, class, requires
    workers: [assisting-pc, operator-pc] # worker IDs (FFFLEET_WORKER_ID), first = priority 1
    others: false                        # default; true = unlisted workers may serve after the listed ones
```

- The first listed worker with a free slot (and the needed capabilities) gets the job. If it is offline or full, the next
  one gets it immediately; the scheduler does not wait for the preferred worker.
- With `others: false` the list is a strict allowlist: if none of the listed workers has room, the job stays queued.
- A job's own `workerPreference` overrides the rules. Jobs matching no rule keep least-loaded placement.
- Pi-only work: give the Pi worker a capability (`FFFLEET_CAPABILITIES=usb`; see docs/worker-roles.md for the planned roles) and match on it with a rule listing
  only `pi`; no other worker can run those jobs anyway because they lack the capability.
- This is separate from job `priority`, which orders the queue.
- Worker IDs must stay stable (set `FFFLEET_WORKER_ID` explicitly on every worker).
- Rules are read at start: restart the orchestrator after editing (`systemctl --user restart fffleet-orchestrator`).
