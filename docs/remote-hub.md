# Run a remote hub

## What this is

Hotel and corporate Wi-Fi often uses AP client isolation. Your phone and laptop
can both reach the internet, but they cannot reach each other, so LAN pairing
fails.

A remote hub is the same signalbox binary running on a routable host. Your phone
and every laptop connect to that host instead. This is self-deploy only - there
is no hosted signalbox service.

## What you are trading

The hub holds a breadcrumb of every prompt and reply from every machine you
point at it. That data lives on a host you rent and is protected by one shared
bearer token. Anyone with the token can read the board and send events.

On machines where even a short breadcrumb must not leave, set
`SIGNALBOX_PROFILE=redacted`. This drops the cwd, title, prompt and reply, and
hashes the session id before sending.

## Get the image

Pull the published image:

```sh
docker pull ghcr.io/dwmkerr/signalbox:latest
```

Or build it from a checkout. Run this from the repository root because the
Docker build context must be the repository root:

```sh
docker build -f components/deploy/Dockerfile -t signalbox-hub .
```

## Run it anywhere with Docker

Create a token and a persistent volume, then run the published image:

```sh
export SIGNALBOX_TOKEN="$(openssl rand -base64 24)"
docker volume create signalbox_data
docker run --name signalbox-hub --detach \
  -e SIGNALBOX_TOKEN \
  -v signalbox_data:/data \
  -p 8377:8377 \
  ghcr.io/dwmkerr/signalbox:latest
```

If you built locally, use `signalbox-hub` as the image name in the last line.
The image sets `SIGNALBOX_REMOTE=1`, so the hub serves plain HTTP and assumes
that the platform or proxy in front of it terminates TLS. Do not expose port
8377 directly to the internet.

## Deploy to Fly

Run the full sequence from the repository root. Pick an app name and region
during `fly launch`, then use that region in the volume command:

```sh
fly launch --no-deploy -c components/deploy/fly/fly.toml
fly volumes create signalbox_data -s 1 -r <region> -c components/deploy/fly/fly.toml
fly secrets set SIGNALBOX_TOKEN="$(openssl rand -base64 24)" -c components/deploy/fly/fly.toml
fly deploy -c components/deploy/fly/fly.toml --dockerfile components/deploy/Dockerfile --ha=false .
```

`--ha=false` keeps one machine attached to one volume. The hub is the single
source of truth and must not be scaled to two machines. `SIGNALBOX_TOKEN` is a
secret: keep a copy somewhere secure and never put its value in `fly.toml`.

## Check it

Set the public URL and the same token you stored on Fly:

```sh
export SIGNALBOX_URL=https://<app>.fly.dev
export SIGNALBOX_TOKEN=...
```

The health check is public and returns `{"ok":true,...}`:

```sh
curl "$SIGNALBOX_URL/healthz"
```

The board returns 401 without the bearer:

```sh
curl "$SIGNALBOX_URL/state"
```

The same request returns the board with the bearer:

```sh
curl -H "Authorization: Bearer $SIGNALBOX_TOKEN" "$SIGNALBOX_URL/state"
```

## Pair a phone

Mint a code against the public hub, then scan the QR from the signalbox app:

```sh
SIGNALBOX_TOKEN=... signalbox pair --url https://<app>.fly.dev
```

The QR carries the HTTPS URL with no `fp` pin. The phone validates the
platform's certificate against the system CAs. The LAN path is different: it
pins the hub's self-signed certificate.

`--url` accepts an `https://` origin only: no path, query, fragment or
credentials. The QR carries the URL's origin. If the token is missing or
empty, the command stops with:
`pairing against --url needs SIGNALBOX_TOKEN set (the remote hub requires a bearer to mint)`.

## Run your laptop as a forwarder

A forwarder is a local `signalbox hub --upstream <url>` that every local client
keeps talking to on loopback, so the remote hub's token lives in exactly one
place on the machine instead of in every hook environment.

### Set it up

Persist the upstream and its token:

```sh
signalbox config set hub.upstream https://<app>.fly.dev
signalbox config set hub.token <the same token the hub runs with>
```

Restart the menu bar app or the hub so it re-reads the settings. The app starts
the forwarder itself with no flags. `make install` also stops the existing hub,
then the app starts it again.

`SIGNALBOX_UPSTREAM` and `SIGNALBOX_TOKEN` in the environment take precedence
over the persisted values. To run the forwarder explicitly in the foreground:

```sh
signalbox hub --upstream https://<app>.fly.dev
```

Hooks, the CLI and the menu bar app keep using tokenless loopback after that.

### Check the uplink

```sh
curl -s http://127.0.0.1:8377/healthz
```

The response includes the upstream status:

```json
{"ok":true,"version":"<version>","upstream":{"url":"https://<app>.fly.dev","connected":true,"lastSeq":42,"spooled":0}}
```

`connected` says whether the forwarder is connected to the upstream stream,
`lastSeq` is the latest upstream sequence it has received, and `spooled` is the
number of local events waiting to be sent.

### When Wi-Fi drops

Events wait in `~/.local/state/signalbox/forward-spool.jsonl`. The spool holds
up to 10,000 events or 16 MiB, whichever comes first, and drops the oldest
events past that limit. The board keeps rendering from its local read cache
instead of going blank. Events replay in order with at-least-once delivery when
the connection returns.

### Pair a phone

A forwarder refuses pairing with a 409. Pair against the upstream from a
machine that has the token:

```sh
SIGNALBOX_TOKEN=... signalbox pair --url https://<app>.fly.dev
```

The app's Connect Phone window reports that the hub needs "other devices
allowed" when it reaches a forwarder. That message is imprecise: use
`signalbox pair --url` against the upstream instead. Phone jumps then relay
through the forwarder to this laptop. Routing jumps among multiple laptops is
future work.

### What it does not own

A forwarder owns no state, writes no `events.jsonl`, and assigns no `seq`. Its
read cache is an in-memory replica of the upstream. It serves loopback only;
`--bind` alongside `--upstream` is refused.

## Point your machines at it

### Use a forwarder (preferred)

On each laptop, [run a local forwarder](#run-your-laptop-as-a-forwarder). The
upstream credential then lives in one place on that machine, events tolerate
offline periods, and hooks, the CLI and the menu bar app need no other
configuration.

### Connect directly

Pointing clients straight at the remote hub is still supported and can be the
simplest option for a headless box. Set the URL and shared token where its hooks
and CLI can see them:

```sh
export SIGNALBOX_URL=https://<app>.fly.dev
export SIGNALBOX_TOKEN=...
```

With this option, the token lives in every hook environment rather than only in
the local forwarder.

## Where things live

The image sets `SIGNALBOX_STATE_DIR=/data`. The durable event log is
`/data/events.jsonl` on the mounted volume. The one-time pairing slot is only
held in memory, so a redeploy clears a pending code.

Each machine writes `machine-id` in its signalbox state directory, by default
`~/.local/state/signalbox/machine-id`. This stable id travels with events
alongside `host`.

## Specs

- [CLI](../components/specs/cli.md) covers `hub` and `pair`.
- [Events](../components/specs/events.md) defines endpoints, binding and auth.
- [Architecture](../components/specs/architecture.html) describes the remote-hub tier.
