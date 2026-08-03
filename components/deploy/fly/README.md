# Fly deploy for the signalbox hub

`fly.toml` here deploys the hub as a single Fly machine with one volume. The
deploy commands are in [docs/remote-hub.md](../../../docs/remote-hub.md); this
file is the detail behind them.

What the config pins down, and why:

- `internal_port = 8377` - the hub's port. The health check dials the machine
  directly on it, so if you change the hub port, change it here too or the app
  reports unhealthy while `curl /healthz` through the proxy works.
- `[[http_service.checks]]` on `/healthz` - unauthenticated by design; every
  other route needs the bearer.
- `force_https = true` - Fly's proxy terminates TLS; the hub itself serves
  plain HTTP (`SIGNALBOX_REMOTE=1` in the image).
- `auto_start_machines = true` + `min_machines_running = 1` - Fly starts a
  machine as soon as one exists, which is why `SIGNALBOX_TOKEN` must be set as
  a secret BEFORE the first deploy: a hub with no token exits immediately and
  burns the machine's restart budget.
- `[[mounts]]` on `/data` with `SIGNALBOX_DATA_DIR = '/data'` - the event log
  lives on the volume and survives deploys. One machine, one volume: the hub
  is the single source of truth, so always deploy with `--ha=false`.
- `[[vm]]` shared 1 CPU / 1GB - plenty; the hub is a small single process.

The token is a secret (`fly secrets set SIGNALBOX_TOKEN=...`), never a value
in this file - `fly.toml` is committed.
