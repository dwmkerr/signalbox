signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | [ios](https://dwmkerr.github.io/signalbox/specs/ios.html) | [architecture](https://dwmkerr.github.io/signalbox/specs/architecture.html) | [cli](cli.md) | data model | [agent integrations](adapters.md)

# Specification: signalbox data model

Two things travel on the wire: events and commands.

An **event** is a fact: something happened. Agents fire events as they work; the hub folds them into one **session** per key, logs every one, and replays them to whoever reconnects. Everything below up to [Commands](#commands) is about events.

A **command** is a request: do something now. A surface fires a command to make a machine act - today, to [jump](#commands). The hub fans it out and forgets it; it is never logged, reduced, or replayed.

A command re-enters as an event. A jump is a command; the `seen` it produces is an event. Every command re-enters as an ordinary fact, so the event log is the only record that a command was carried out. The reply is the next fact; there is no separate reply channel.

There are two event shapes: the event an agent fires, and the session row the hub returns. They share their fields; the session adds the five the hub derives (`seq`, `acked`, `hidden`, `pinned`, `engaged_ts`).

## The event

What an agent fires. The hub sets `seq`, `acked`, `hidden`, `pinned`, and `engaged_ts`; a fired event omits them.

Every field explained in place. Optional fields are omitted from the JSON when empty.

```jsonc
{
  // Schema version. Always 1 today.
  "v": 1,

  // Unique id for this event (uuid), and when it was fired (UTC).
  "id": "0197-...",
  "ts": "2026-07-07T18:04:11Z",

  // The display name of the machine the event fired on. Two laptops on one
  // remote hub may have the same host.
  "host": "daves-mbp",

  // Stable identity of the machine that fired the event. Read or created at
  // machine-id in the state dir as <short hostname>-<6 hex>, then cached in
  // the process and reused. Agent events and user-action events both stamp it.
  // Unlike host it does not collide when two laptops share a display name.
  // Optional on read and not required by validation, for old logs and emitters.
  "machine": "daves-mbp-3f9a2c",

  // Who is doing the work. This is also the row's icon: claude, opencode,
  // pi and github have glyphs, anything else gets the fallback ring. An
  // editor-hosted agent carries a "<host>/<agent>" display name (e.g.
  // "vscode/claude", "cursor/claude") - the editor's mark with the agent glyph
  // badged. The host prefix is display only; session_key keeps the family.
  "agent": "claude",

  // What happened. Agent lifecycle: busy, attention, done, error, ended.
  // User actions: seen, hide, show, pin, unpin, label, tag, untag (they change
  // how a session is shown, never what the agent did). `jump` is a command,
  // not an event - see commands below.
  "event": "done",

  // Optional detail on the event: permission_prompt, stop, session_end, ...
  // Attention reasons an adapter should prefer when it knows why the agent is
  // blocked: "permission_request" (a tool call awaits approval; reply carries
  // the actual ask, e.g. "Bash: git push origin main") and "question" (the
  // agent asked the user something; reply carries the question and its
  // options). Surfaces may render these distinctly; unknown reasons render as
  // plain attention, so the vocabulary can grow without breaking anyone.
  "reason": "stop",

  // The stable identity of the session: "<agent-family>:<session id>". Every
  // event with the same key updates the same row. The family is the base agent
  // ("claude"), not the display `agent` field: an editor-hosted session shows
  // agent "vscode/claude" or "cursor/claude" for its icon, but still keys on
  // "claude:<id>" so it never splits between a plain terminal and the editor.
  "session_key": "claude:9f2a...",

  // Where the work is happening.
  "cwd": "/Users/dave/repos/work-project",

  // Names, in priority order: label is the user's own name for the session
  // (max 80 chars, set with `signalbox session rename` or the jumplist rename, and
  // only ever by a label event); title is the agent's name for it (a
  // /rename, or the cwd folder name).
  "label": "deploy",
  "title": "work-project",

  // Discreet, free-form tags. Carried across agent events; added or removed
  // with tag/untag events (or set on the creating event).
  "tags": ["work"],

  // The exchange breadcrumb: your last prompt (max 160 chars) and the
  // agent's last message (max 280 chars). One line each, cropped before
  // they leave the emitting process. Never transcripts. (`prompt` was
  // `detail` before v0.2; the hub still reads `detail` from old events. On
  // the same read path, an event with no machine gets machine = host, so a
  // pre-upgrade events.jsonl and older emitters behave exactly as before.)
  "prompt": "good enough. commit work for now.",
  "reply": "Done - the dashboard now shows per-post traffic.",

  // Where to jump to. `kind` names the origin type so more can be added
  // later (ssh); today tmux, url, or cursor (an editor window - the kind
  // covers every VS Code-family editor: Cursor, VS Code, other Electron
  // forks). Exactly one of the payload fields may be set; old events
  // without `kind` get it inferred from whichever field that is. Captured
  // when the event fires, so jumping never depends on the local setup.
  "origin": {
    "kind": "tmux",
    "tmux": {
      "session": "work-project", "window": 1, "pane": "%12",
      "socket": "/private/tmp/tmux-501/default",
      "terminal": "com.googlecode.iterm2"
    }
    // or: "url": "https://github.com/dwmkerr/signalbox/actions/runs/9182"
    // or: "cursor": { "bundle": "com.todesktop.230313mzl4w4u92" } - just the
    // editor's bundle id; jump finds the window by app plus the event's cwd,
    // so redact has nothing extra to strip.
  },

  // The agent's process, so the hub can end sessions whose process died
  // without a goodbye (a killed TUI, a crash).
  "proc": { "pid": 12345, "name": "claude" },

  // Diagnostic only: the untouched adapter payload, attached when
  // SIGNALBOX_RAW is set so the raw hook JSON can be inspected from the
  // hub's event log. Never set in normal operation; the redacted profile
  // strips it.
  "raw": "{\"hook_event_name\":\"Stop\", ...}",

  // Set by the hub, never by the sender: seq is the ingest order; acked,
  // hidden, pinned and engaged_ts are derived state (see below) that the hub
  // serializes onto /state rows (each omitted when false/empty).
  "seq": 118,
  "acked": true,
  "hidden": false,
  "pinned": false,
  "engaged_ts": "2026-07-07T18:02:40Z"
}
```

## The session

What `GET /state` returns: an event plus the five fields the hub derives.
`seq` is ingest order; `acked`, `hidden`, `pinned`, and `engaged_ts` come from
the rules below. A fired event that tries to set them is ignored.

`/state` and `/stream` are served with `Cache-Control: no-store`: both double
as liveness signals for clients, and a cached answer makes a dead hub look
alive (the iOS board once showed stale rows with a fresh last-seen while every
real connection failed).

## How events become sessions

The hub keeps one row per `session_key`, following these rules:

- **Latest event wins.** A new agent event replaces the row's status. `ended` removes the row (the event log keeps everything).
- **Breadcrumbs carry.** `prompt`, `reply`, `origin`, `proc` and `machine` persist across events that omit them, so a done without prompt text keeps showing the prompt that started it and an older emitter cannot blank the machine identity. `label` always carries, and only a `label` event can change or clear it.
- **An enriched ask is not clobbered by its bare twin.** One blocked dialog can reach the hub twice (e.g. Claude's `PermissionRequest` with the real ask in `reply`, and its bare `Notification` with only "Claude needs your permission"). While a row is in attention, a second attention event whose `reply` is empty or carries no more than the generic message keeps the richer `reply` already on the row, regardless of arrival order. Any non-attention agent event ends the ask and normal reply rules resume.
- **Tags carry.** `tags` persist across agent events that omit them (like `prompt`/`reply`), but an event carrying its own `tags` keeps them - even when the session already existed untagged. `tag`/`untag` events add or remove them. Filter with `state --tag` / `--exclude-tag`.
- **New activity resets your flags.** Any agent event clears `acked` and `hidden` - a hidden session that speaks again comes back.
- **A pin is yours until you drop it.** `pinned` (set by `pin`, cleared by `unpin`) carries across agent events like `label`: new activity never clears it, so a pinned session that speaks again stays pinned. Only `unpin` or `hide` removes a pin. `ended`/expiry removes the whole session; a pin does not resurrect or protect it.

## Read, hidden, and gone

Four user actions on a row's visibility, in ascending strength:

- **seen** (`signalbox session ack`, or any jump): the row is dealt with. It stays on the board, drawn quiet, until the agent speaks again.
- **hide** (`signalbox session hide`, jumplist `⌃X`): the row disappears until the agent speaks again. Hiding a running session downgrades to seen - running work must stay visible.
- **show** (`signalbox session show`): the reverse of hide - a hidden row reappears in place, with no ack and no reorder. A no-op on a row that is not hidden.
- **ended** (`signalbox session remove`, jumplist `⌃⌫`): the row is gone now.

The hub also ends sessions on its own, with an `ended` event like any other (reason `expired` or `exited`; `signalbox session remove` fires reason `removed`): after `SIGNALBOX_EXPIRE` (default 24h) without an agent event - checked every 10 minutes and once at boot - and within about 30 seconds of the agent's process dying without an exit event (only processes on the hub's own host are checked). A dead process gets an `ended` event.

## Pinning

**pin** (`signalbox session pin`) floats a session into a partition at the top of the board and keeps it there; **unpin** (`signalbox session unpin`) releases it. Both are idempotent. A pin outlives agent activity: `pinned` carries across every event until you remove it. Two things end a pin: `unpin`, and `hide`. Hiding a pinned session drops the pin before applying its own rule (busy downgrades to seen, else hidden). An `ended` (remove, expiry, a dead process) takes the whole session off the board; a pin does not resurrect or protect it.

## Ordering

Rows keep the order you work in, like the app switcher: most recently engaged first. Engagement means you did something - a prompt you typed, a jump, an ack. Status changes never reorder rows, so the board stays spatially stable while you cycle between sessions.

`engaged_ts` on each `/state` row is this sort key. Sessions you never engaged hold their arrival position.

**Pinned rows form a top partition.** Every pinned session sorts above every unpinned one; engagement-MRU then orders each partition internally. A pin therefore floats a row above more-recently-engaged unpinned rows without reordering the pinned group among itself. The hub owns this order and every surface adopts it verbatim.

## Commands

Everything above is an **event**: a fact about what happened. Facts are logged, folded into a session, and replayed to whoever reconnects. A **command** is a request addressed to a machine *right now*. It is not logged, folded, or replayed.

There is one command today.

| Command | Meaning |
|---|---|
| `jump` | Whichever machine owns this session, jump to it. |

Jumping is machine-local: it spawns tmux against a socket on a local filesystem, or raises a local window. A phone cannot jump itself, but it can ask the laptop to, over the hub bus every surface listens on.

```jsonc
{
  "v": 1,
  "id": "e8f1-...",              // provenance and debugging only
  "ts": "2026-07-16T09:12:33Z",  // provenance only - never a correctness gate

  // The kind. Named `command`, not `event`, and that is load-bearing: see below.
  "command": "jump",

  "session_key": "claude:9f2a...",

  // The host the caller read off the row it tapped. The executing machine acts
  // only if this AND the session's own host both name it: a disagreement must
  // be a no-op, never a jump on the wrong machine.
  "target_host": "mbp",

  // Where the tap happened. Provenance for the debug surface; never routing.
  "host": "daves-iphone"
}
```

**A command is never persisted.** The hub logs every event, and `GET /stream?since=N` replays that log to a reconnecting client, so a logged jump would fire again on the next app restart and move a window hours after the tap. A client whose `/state` is empty reconnects from seq 0 and would replay *every jump ever fired*. So a command skips the log, the reducer, and `seq`; it exists only in flight. `seq` stays contiguous across the log as commands pass through, and a command cannot be acked, ordered, or recovered. If nobody is listening, nothing happens.

It carries no `seq` for a second reason: the hub restarts `seq` from the highest *persisted* value on boot, so a seq consumed but never written would be handed out again after a restart, and a client's monotonic guard would then silently drop that real event.

Commands ride the same `/stream` connection as events, on their own frame name:

```
event: signal    data: {...}     an event  (carries seq, replayed from the log)
event: command   data: {...}     a command (no seq, live-only, never replayed)
```

**Why the field is named `command`.** A client that predates commands must not break on one. Readers decode `event` as a required field and drop what fails to parse, so a payload with no `event` key is inert to an old client: it is skipped. A field named `event` would decode cleanly and reach the reducer, where any unknown type is treated as an agent status, and the row's status would read `jump`. The field name keeps an additive hub change safe for clients that have not been rebuilt.

### Requesting and confirming

| Endpoint | Behaviour |
|---|---|
| `POST /command` | Validate, fan out to every live stream, forget. Returns `{"ok": true, "delivered": 2}`. Requires `Content-Type: application/json`. |

`delivered` counts the listeners the command was written to, confirming fan-out only. `delivered: 0` means no machine is listening; a caller should report that plainly rather than leave it to a timeout.

The hub does not adjudicate targets: whoever owns the session decides whether to act, so a command naming a session the hub has never seen is still delivered.

Executing a remote jump fires a `seen` from the machine that did it, exactly as a local jump does, and `seen` fires only once the jump has landed. That is the confirmation: the caller learns its jump worked by watching the board go quiet.

## The hub API

The default posture is `http://127.0.0.1:8377`, loopback only, with no auth. Wide-bind and remote-mode postures are specified below.

| Endpoint | Behaviour |
|---|---|
| `POST /events` | Validate, assign `seq`, append to the log, update state, broadcast. Returns `{"seq": 118}`. Requires `Content-Type: application/json`. |
| `POST /command` | Fan out a [command](#commands) to every live stream and forget it: no `seq`, no log, no state. Returns `{"ok": true, "delivered": 2}`. |
| `GET /state` | `{"sessions": [...]}` in display order. |
| `GET /stream?since=N` | Server-sent events: replay everything after seq N, then live. Heartbeat every 15s. Commands are live-only and never appear in the replay. |
| `GET /healthz` | `{"ok": true, "version": "0.1.5", "build": "d6907e1-dirty", "mode": "local"|"lan"|"remote", "bind": "127.0.0.1", "port": 8377}`. `mode` is the single oracle for which runtime is answering: it is stated and must never be inferred from `bind` or from the presence of other keys. `version` is the bare semver and `build` is empty on an unstamped build. Never authenticated - platform health checks reach it from anywhere. |
| `POST /pair` | Trade a valid [pairing code](#pairing) for the bearer token: `{"token": "..."}`, or `401 {"error": "invalid or expired pairing code"}` for any failure. Unauthenticated - the code is the credential. Requires `Content-Type: application/json`. |
| `POST /pair/new` | Mint a pairing code. Reachable from a loopback peer or with a valid bearer; in remote mode the bearer is always required. Returns `{"code", "expires_in": 180, "bind"}`, plus `"fp"` (cert pin) and `"port"` (TLS listener) when the hub exposes pinned LAN TLS. A missing or wrong bearer is `401` off loopback, or from any peer in remote mode; `409` with no token configured or a loopback bind. Requires `Content-Type: application/json`. |
| `GET /pair/status` | Read the pairing slot's state for `signalbox pair`: `{"status": "pending" \| "redeemed" \| "none"}`. Reachable from a loopback peer or with a valid bearer; in remote mode the bearer is always required. A missing or wrong bearer is `401` off loopback, or from any peer in remote mode. |

The hub appends every event to `events.jsonl` in the state dir and rebuilds its state from that file on boot; `seq` continues from the highest persisted value. Commands are not written, so they are never rebuilt or replayed. Only `application/json` may post (blocks cross-origin form posts from hostile pages), and bodies are capped at 1 MiB.

On `SIGTERM`, the hub closes its append file descriptor and exits successfully. This gives a container platform a prompt clean stop instead of waiting out its kill timeout, and prevents a redeploy from interrupting a JSONL append.

### Binding and auth

The hub's default posture binds `127.0.0.1`. `signalbox hub --bind <host>` (or `SIGNALBOX_BIND`) selects another bind - e.g. `--bind 0.0.0.0` to serve other machines - while remote mode selects a separate proxy-facing auth posture. Auth is decided by the connection's real peer address, never the client-controlled `Host` header:

- **Loopback peer outside remote mode** (`127.0.0.0/8`, `::1`): no token required, exactly the v0 contract. The peer's `Host` header must still be a loopback literal (DNS-rebinding defence: a hostile page can point a name it controls at `127.0.0.1` and read `/state` same-origin). Local hooks and the menu bar app keep working unchanged even when the hub is bound wide.
- **Non-loopback peer**: must send `Authorization: Bearer $SIGNALBOX_TOKEN`, compared in constant time. A missing or wrong token is `401` with `WWW-Authenticate: Bearer`. The loopback-`Host` check is skipped once the token has proved the caller (a hostile webpage cannot attach a bearer header cross-origin; the hub grants no CORS).
- **Remote mode**: `signalbox hub --remote` (or `SIGNALBOX_REMOTE=1` or `true`) means the hub sits behind a proxy that terminates TLS, so the peer address is the proxy's and the loopback exemption is never granted. Every request that passes through the auth gate needs the bearer, including one from a loopback peer, and `SIGNALBOX_TOKEN` is mandatory at boot.

`GET /healthz` and `POST /pair` are the only exemptions from these checks, and both remain exempt in remote mode. `/pair` is exempt because the pairing code it carries is itself the credential (see [Pairing](#pairing)). A non-loopback bind is never served without a token: outside remote mode the hub resolves or generates one as described below, and the startup validation refuses the bind if it is still absent. Remote mode instead requires `SIGNALBOX_TOKEN` from the environment and exits before token generation when it is missing or empty.

Outside remote mode, the `hub` section of `~/.config/signalbox/settings.json` (`hub.bind`, `hub.token`) is the persistent, file-backed equivalent of `--bind` and `SIGNALBOX_TOKEN`, so the hub the menu bar app spawns (it passes only `--port`) can let other devices connect with no flags. The bind resolves as `--bind` flag, then `SIGNALBOX_BIND`, then `hub.bind`, then loopback; the token as `SIGNALBOX_TOKEN`, then `hub.token`. `hub.bind` is stored as a literal address the hub binds verbatim (`config set` normalizes friendly words like `any` to `0.0.0.0` and refuses the ambiguous `lan` before saving); the `0.0.0.0` wildcard is what lets other devices connect while loopback stays served. When the resolved bind is non-loopback and no token is set either way, the hub **generates a token and saves it to `hub.token`**, so the startup validation is a backstop. Remote mode ignores both persisted values: its default bind is `0.0.0.0` and its token comes from `SIGNALBOX_TOKEN` only. See the [CLI spec](https://github.com/dwmkerr/signalbox/blob/main/components/specs/cli.md#config) for `signalbox config`.

### The forwarder

`signalbox hub --upstream <url>` runs a forwarder instead of a state-owning hub. It has no local state write path, writes no `events.jsonl`, and never assigns `seq`; only the upstream hub assigns sequence numbers. Its `Store` is an in-memory read cache materialized from the upstream downlink, not a source of truth.

A local surface distinguishes a forwarder from a hub by `mode`, not by probing for an `upstream` key.

The local listener is always unauthenticated http on `127.0.0.1` (port 8377 by default). Local hooks, the CLI and the menu bar app continue to use loopback with no bearer token. The loopback `Host` check still rejects DNS-rebinding attempts on every route behind the health check; `/healthz` keeps the hub's platform-health exemption.

| Endpoint on a forwarder | Behaviour |
|---|---|
| `POST /events` | Normalize and validate, remove derived fields and `seq`, append to `${stateDir}/forward-spool.jsonl` under its `.lock`, start an asynchronous drain, and immediately return `202 {"spooled": true}` without waiting for the upstream. This response acknowledges spooling only and carries no `seq`; the upstream assigns one on ingest after the drain delivers the event, and the forwarder receives it later through the downlink. The hook client allows its POST only 200 ms; waiting for a WAN round trip would make the hook spool an event that the forwarder might also have delivered. The drain is the only sender of spooled events, so delivery stays FIFO and there is one spool. |
| `POST /command` | Validate and synchronously proxy to the upstream. A successful upstream response supplies the same `{"ok": true, "delivered": N}` body; any upstream failure returns `502` with an error body. Commands are never spooled because a stale request has no meaning. |
| `GET /state` | Return `{"sessions": [...]}` from the in-memory downlink cache. |
| `GET /stream?since=N` | Replay cached `signal` frames after N, then re-broadcast live `signal` and `command` frames from the downlink. The signal backlog is bounded to the newest 2,000 events; commands remain live-only. The stream sends an immediate `: connected` comment so a same-process fetch receives first bytes before the first event, then the normal 15-second heartbeat comments. |
| `GET /healthz` | Return `{"ok": true, "version": "0.1.5", "build": "d6907e1-dirty", "mode": "forwarder", "port": 8377, "upstream": {"url": "https://my-hub.fly.dev", "connected": true, "lastSeq": 118, "spooled": 0}}`. `mode` is the single oracle for which runtime is answering: it is stated and must never be inferred from the presence of `upstream` or other keys. `version` is the bare semver and `build` is empty on an unstamped build. Never authenticated. |
| `POST /pair`, `POST /pair/new`, `GET /pair/status` | Return `409` with a message naming `signalbox pair --url <upstream>`. A forwarder owns neither the state nor the pairing token. |

The uplink opens `GET <upstream>/stream?since=<lastSeq>`, using `since=0` on first connect to build the cache from the full upstream log. It sends the resolved bearer when one is configured, resumes after the last seen upstream `seq`, and reconnects after 1 second with exponential backoff capped at 15 seconds. `signal` frames are normalized, applied to the cache, added to the bounded backlog and re-broadcast. `command` frames are only re-broadcast and never touch the cache. The same resolved credential is used for event and command POSTs; a tokenless forwarder sends no Authorization header, which supports an unauthenticated loopback upstream but normally leaves the upstream to reject the request.

The forward spool is bounded by 10,000 events or 16 MiB, whichever limit is reached first. Overflow drops the oldest events and writes one log line when the overflow episode begins. Drains send oldest first. Uplink delivery is at-least-once: a crash after a successful send but before the reconcile write can resend an event on the next drain, which is safe because events carry unique ids and the reducer is last-write-wins. An upstream 4xx permanently drops that event so it cannot wedge the queue; a network error or any other upstream status keeps it for a later pass. Spooled events carry no `seq` because the upstream assigns one on ingest.

The cache is fed only by the downlink. A local `POST /events` returns `202 {"spooled": true}` as soon as the event is spooled; that acknowledgement has no `seq`, and the event is neither applied nor broadcast locally. The drain later sends it upstream, where ingest assigns `seq`; the sequenced event arrives asynchronously over the downlink and is then applied to the cache exactly once. Nothing originates local state, so there is nothing to reconcile or deduplicate.

### Pairing

`signalbox pair` gets the bearer token onto a phone without ever showing it. The hub mints one ephemeral code; the phone reads a QR carrying the hub URL and that code, POSTs the code to `/pair`, and receives the token in return. The pairing slot lives only in memory - like a command it is never persisted, so a restart clears it.

- **`/pair` is the second unauthenticated exemption, beside `/healthz`.** It sits above the auth gate because the code it carries *is* the credential. Every failure - no code, expired, wrong, already redeemed, or a non-string code - returns one uniform `401 {"error": "invalid or expired pairing code"}`, so an attacker gets no oracle for which case it hit.
- **`/pair/new` and `/pair/status` sit below the auth gate.** Outside remote mode, a loopback peer or any valid bearer holder may mint and inspect a pairing; remote mode always requires the bearer. A token holder is already fully trusted and can read every prompt and forge events, so the old peer restriction bought nothing against them and blocked `pair --url`. This audience change leaves the uniform `401` on `/pair`, the single slot, single-use redemption, and the 180-second lifetime unchanged.
- **A code is single-use and short-lived**: 128 bits from a CSPRNG, base64url, 180 seconds. Minting replaces the one existing slot, so only the newest code is live. Redemption is synchronous - the slot is marked redeemed before the handler yields - so racing requests cannot redeem one code twice. There is deliberately **no failed-attempt invalidation and no attempt counter**: a cap is a denial-of-pairing lever and useless against a 128-bit space.
- **`Content-Type: application/json` is required on `/pair` and `/pair/new`**: it blocks the CORS "simple request" a hostile page could POST cross-origin without a preflight.
- **The phone's LAN transport is pinned TLS (#25).** When LAN devices are allowed outside remote mode, the hub serves them over https with a persisted self-signed cert, on a listener one port above the loopback http port; local clients keep plain http on loopback (no MITM risk there), so nothing local trusts the cert. The mint carries the cert's SHA-256 DER fingerprint (`fp`) and TLS port; the QR carries `fp` only when both are present, and the phone refuses any certificate that does not match. This closes the LAN's plaintext gap - a same-network attacker could otherwise read prompts/replies or forge events - without a CA or any user ceremony. `openssl`-less hosts fall back to plain http with no pin. Remote mode creates no self-signed listener; an https `pair --url` link carries no `fp`, and the phone uses system CA validation for the platform certificate.

What pairing does and does not do:

- It **does not remove the token from later authenticated requests.** The bearer still crosses the transport on every such request, inside pinned TLS for the normal LAN path or platform TLS for a remote https URL. What pairing removes is the token from *screens, QR images, terminal scrollback, and clipboards* - the places a long shared secret leaks by being copied around by hand.
- **Outside remote mode, any local process can mint and redeem to obtain the token.** Loopback is fully trusted there, as elsewhere in the normal hub posture (local hooks post unauthenticated): a process already running as you on the hub machine can read the token from the environment or config regardless. Remote mode requires the bearer even for a local mint or status request.

## Privacy

Signals and a two-line breadcrumb of the exchange, never transcripts. `prompt` and `reply` are the only content-bearing fields in normal operation and both are cropped at the emitter (the diagnostic `raw` field is opt-in via `SIGNALBOX_RAW`). The redacted profile (`SIGNALBOX_PROFILE=redacted`) drops cwd, title, prompt, reply and raw, and hashes the session id - for machines where even one line must not leave. It keeps `machine`: the value is the already-retained hostname plus random hex, so it discloses nothing further while preserving stable machine identity.
