# Run a remote hub

Running a Signalbox hub on a remote server allows you to pair your phone without being on the same network, as well as having multiple machines forward to one central location:

<img src="images/remote-hub.svg" width="560" alt="Two machines forward their agent sessions to a remote hub; a phone connects to the hub.">

## Deploying a remote hub

Signalbox has ready-to-go example configuration for [fly.io](https://fly.io) in [`components/deploy/fly`](../components/deploy/fly/) - clone the repository to use it, since the deploy needs `fly.toml` and the Dockerfile from the checkout.

In short, from the repository root:

```bash
# Create the app (pick a name and region, no deploy yet).
fly launch --no-deploy -c components/deploy/fly/fly.toml

# Create a volume for the event log, in the region you picked.
fly volumes create signalbox_data -s 1 -r <region> -c components/deploy/fly/fly.toml

# Create a token and store it as a secret - set it BEFORE the first deploy, and keep a copy.
export SIGNALBOX_TOKEN="$(openssl rand -base64 24)"
fly secrets set SIGNALBOX_TOKEN="$SIGNALBOX_TOKEN" -c components/deploy/fly/fly.toml

# Deploy; one machine, one volume - the hub must not scale to two.
fly deploy -c components/deploy/fly/fly.toml --dockerfile components/deploy/Dockerfile --ha=false .
```

Once you have deployed a remote hub, point Signalbox on your local machine to it. Go to 'Settings > Hub', choose 'Mode: Remote', enter your hub address and token, then 'Test' and 'Confirm' - Confirm enables once the test passes. Or from the CLI:

```bash
# Point the local hub at the remote hub and store the token.
signalbox config set hub.upstream https://<app>.fly.dev
signalbox config set hub.token "$SIGNALBOX_TOKEN"
```

When offline, the hub runs locally and replays events to the remote hub when reconnected.

You can also run the hub manually in any location with the published Docker image:

```bash
# Run the hub with a token and a persistent volume.
export SIGNALBOX_TOKEN="$(openssl rand -base64 24)"
docker volume create signalbox_data
docker run --name signalbox-hub --detach \
  -e SIGNALBOX_TOKEN -v signalbox_data:/data -p 8377:8377 \
  ghcr.io/dwmkerr/signalbox:latest

# From your machine, check the connection.
curl -s http://<host>:8377/healthz
curl -s -H "Authorization: Bearer $SIGNALBOX_TOKEN" http://<host>:8377/state
```

The image sets `SIGNALBOX_REMOTE=1`, so the hub serves plain HTTP and expects the platform in front of it to terminate TLS - do not expose port 8377 directly to the internet. State lives on the `/data` volume.

## Pair a phone

Choose 'Connect Phone' in the menu bar app and scan the QR, exactly as you would on a LAN. Your Mac is a forwarder, so it cannot mint a code itself: the window mints against the remote hub with the token you entered in 'Settings > Hub', shows the QR, and waits for the phone to redeem it. The QR carries the hub's public address and the one-time code, never the token.

If the window cannot mint - no token stored on this machine, a token the hub rejects, or a hub it cannot reach - it says why and hands you the command to run on any machine that holds the token:

```bash
export SIGNALBOX_TOKEN="<your hub token>"
signalbox pair --url https://my-hub.fly.dev
```

## Troubleshooting

**Troubleshooting a Fly deploy**

```bash
# Curl hangs forever: the machine cannot start - almost always a missing token.
fly logs -c components/deploy/fly/fly.toml      # Look for: remote mode requires SIGNALBOX_TOKEN.
fly status -c components/deploy/fly/fly.toml    # Machine stopped at "max restart count".

# Recover: set the secret, then start the stopped machine by hand.
fly secrets set SIGNALBOX_TOKEN="$(openssl rand -base64 24)" -c components/deploy/fly/fly.toml
fly machine start <id> -c components/deploy/fly/fly.toml

# Beware: SIGNALBOX_TOKEN="$TOKEN" with $TOKEN unset sets an EMPTY secret - same symptom.
echo "${TOKEN:?TOKEN is not set}" | head -c 8   # Prove it is non-empty first.
```

A 401 on `/state` is not a failure - every route except `/healthz` and `POST /pair` needs the bearer.

## Configuration

- `SIGNALBOX_TOKEN` - the bearer token; required in remote mode, never in `fly.toml` (it is committed).
- `SIGNALBOX_REMOTE=1` - remote mode: plain HTTP behind platform TLS, token on every request. Set by the image.
- `/data` volume - the event log; one machine, one volume.
- `hub.remoteUrl` - the app's memory of the last confirmed remote address, so switching modes and back restores it; `hub.upstream` alone decides whether the hub forwards.

Fly specifics (ports, health check, machine sizing) live in [`components/deploy/fly/README.md`](../components/deploy/fly/README.md).
