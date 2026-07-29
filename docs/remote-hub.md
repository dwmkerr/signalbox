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
credentials. The QR preserves that URL verbatim. If the token is missing or
empty, the command stops with:
`pairing against --url needs SIGNALBOX_TOKEN set (the remote hub requires a bearer to mint)`.

## Point your machines at it

Set the URL and shared token where the hooks and CLI can see them on every
machine:

```sh
export SIGNALBOX_URL=https://<app>.fly.dev
export SIGNALBOX_TOKEN=...
```

In this phase, the token has to live in each machine's environment. A local
forwarder that keeps the token in one place per machine is planned but not
built.

## Where things live

The image sets `SIGNALBOX_STATE_DIR=/data`. The durable event log is
`/data/events.jsonl` on the mounted volume. The one-time pairing slot is only
held in memory, so a redeploy clears a pending code.

## Specs

- [CLI](../components/specs/cli.md) covers `hub` and `pair`.
- [Events](../components/specs/events.md) defines endpoints, binding and auth.
- [Architecture](../components/specs/architecture.html) describes the remote-hub tier.
