signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | [ios](https://dwmkerr.github.io/signalbox/specs/ios.html) | [architecture](https://dwmkerr.github.io/signalbox/specs/architecture.html) | cli | [data model](events.md) | [agent integrations](adapters.md)

# Specification: signalbox CLI

signalbox is a single binary. The hook-path commands (`fire`, `hook claude`, `hook cursor`, `hook codex`, `tmux seen-pane`, and the `session` verbs `ack`, `hide`, `show`, `pin`, `unpin`, `rename`, `remove`, `tag`, `untag`) are bounded - one POST with a 200ms timeout and a capped backlog drain - and always exit 0, so a notifier cannot break the agent that called it. The commands you run yourself (`state`, `jump`, `pick`, `init`, `hub`, `config`, `drain`) may fail loudly.

Bare `signalbox` (and `-h`/`--help`) prints a short help: just the human commands. `signalbox help` is the full reference - every command, flag, and environment variable. When a command needs the hub and it is not running, the error names the fix (open the Signalbox app, or `signalbox hub`).

## init

Guided, idempotent setup. One board, rendered two ways: on a terminal it opens
an interactive picker; piped, `--status`, `--yes`, or `-v` prints the same
board read-only. The checkbox is the *desired* state and starts at what's
installed. Check a missing component to set it up, uncheck an installed one to
remove it, `⏎` applies. `d` shows details.

`-v`/`--verbose` adds install paths to each row. Verbose only affects the status
view, so `-v` implies the read-only status board even on a terminal. Plain
`signalbox init -v` shows the board with paths.

```bash
signalbox init               # interactive picker (or status when piped)
signalbox init --status      # the board, read-only, never the picker
signalbox init -v            # status with paths (implies the read-only view)
signalbox init --status -v   # the same: status with paths
```

```text
 ╭───────╮   Welcome to signalbox
 │ ((●)) │   Switch between agent sessions across
 ╰───────╯   terminals and machines.

 signalbox
     ● Menu bar app running (hub + jumplist)

 Integrations
     ● Claude Code hooks active
     ● Cursor hooks active
     ● VS Code jump-back (automatic)
     ● OpenCode plugin installed
     ● pi extension installed
     ○ tmux - not set up, no status count or in-tmux jump

 1 to set up · signalbox init --tmux
```

`●` is set up, `○` is not, with the cost noted. When everything is green the last line points at the jumplist: "Everything is set up. Press `⌃⌥J` to jump between sessions." In the picker a checked-but-
missing row shows `◉ · set up` and an unchecked-but-installed row shows `○ · remove`.

User config policy: JSON agent configs (`~/.claude/settings.json`,
`~/.cursor/hooks.json`) are merged only with consent - checking the row in
the picker or passing the scope flag IS the consent - with a timestamped
backup next to the file and an atomic, parse-validated write. Only events
with no hooks at all are filled; hooks routed through your own wrapper are
never touched (and never doubled). `--remove` is the same edit in reverse:
only the literal `signalbox hook <agent>` commands are removed. Freeform
config (`~/.tmux.conf`) is printed as a snippet by default; `--write-user-config`
writes it as a fenced managed block instead. The binary itself is not init's business: Homebrew owns the CLI on
PATH, and the menu bar app owns the hub. Pass `--yes` to apply
non-interactively.

Scope to one component when you do not want the whole board. Add `--remove`
to turn that component off:

```bash
signalbox init --agent claude          # just wire Claude Code
signalbox init --agent cursor          # wire Cursor's own agent
signalbox init --agent codex           # wire Codex (needs [features] hooks = true)
signalbox init --agent claude --agent pi   # wire two agents
signalbox init --app                   # open the menu bar app (it runs the hub)
signalbox init --tmux                  # just print the tmux snippet
signalbox init --remove --agent pi     # unlink the pi extension
signalbox init --remove --app          # quit the app (the hub stops with it)
```

`~/.claude/settings.json` and `~/.cursor/hooks.json` are merged directly on
the scope flag (the flag is the consent, as above). Freeform or third-party
config (`~/.tmux.conf`, `~/.codex/hooks.json`) gets its snippet **printed**
by default for you to paste. To have signalbox write those too, add
`--write-user-config`:
it backs the file up first, writes a fenced managed block (text) or a keyed merge
(JSON), records the edit in `~/.config/signalbox/managed.json`, and stays
idempotent. `--dry-run` prints the exact change without writing. `--reverse`
removes only signalbox's own edits (the mirror of `--remove` for written files).
A file another tool manages (a koi-managed Codex `hooks.json`) stays print-only
even with `--write-user-config`, because a blind rewrite would break its trust
hash. See [init.html](init.html) for the full model.

```bash
signalbox init --tmux --dry-run                 # preview the change
signalbox init --agent codex --write-user-config   # write it (with a backup)
signalbox init --agent codex --reverse             # remove signalbox's edit
```

With no scope flag, `init` converges everything. `--agent all` wires every known agent.
Uninstalling entirely is brew's job: `brew uninstall --cask signalbox`, with
`--zap` to drop state and preferences too.

## state

Show the board.

```bash
signalbox state
```

```text
STATUS          AGENT   TITLE            KEY           AGE  PROMPT
● needs you     claude  work-project     claude:9f2a   37s  good enough. commit work for now.
● ready         claude  AI-wellness      claude:1c44   2m   pls update tasks in notion
◌ working       pi      crash-dumps      pi:77b1       6s   summarise the crash dumps
· ready (seen)  claude  claude-toolkit   claude:3ac2   23h
```

The marks are the [status marks](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) in terminal form: amber `●` needs you, blue `●` ready, `◌` working, dim `·` read, red `✕` failed. On a TTY, seen and hidden rows dim; piped, they carry a `(seen)` or `(hidden)` suffix instead. `--json` prints the raw `/state` document; `--all` includes hidden rows.

## jump

Jump to a session's origin and mark it seen.

```bash
signalbox jump claude:9f2a
```

For a tmux origin this switches the right tmux server to the exact pane and raises the terminal window it lives in. For a URL origin (a CI run, for example) it opens the browser; http/https only, anything else is refused. For an editor origin (Cursor's own agent, or an agent in a VS Code / Cursor integrated terminal) it activates the editor by bundle id and best-effort raises the window matching the workspace folder. This is window-level because editor tabs are not externally addressable. Everything jump needs was captured when the event fired.

## pick

An interactive picker over the current sessions - fzf when installed, a numbered menu otherwise. Enter jumps. Designed for a tmux popup:

```text
bind-key j display-popup -E -w 80% -h 15 "command -v signalbox >/dev/null && signalbox pick || echo signalbox is not installed"
```

## tmux - terminal integration

`signalbox tmux status` prints one line for tmux `status-right`, using the same temperatures: amber asking, blue unread, red failed. Empty when nothing waits.

```bash
signalbox tmux status
```

```text
#[fg=colour214]● 1#[default] #[fg=blue]● 2#[default]
```

It never hangs (200ms timeout) and never errors visibly; a dead hub renders as an empty segment.

`signalbox init` reports the tmux integration as set up when it finds signalbox in the running tmux server's `status-right` (set live with `set-option`), or in `~/.tmux.conf` or `~/.config/tmux/tmux.conf` (the XDG path). Detection matches what tmux is actually running.

## fire

Fire an event. This is how scripts, cron jobs, and CI get on the board.

```bash
signalbox fire --agent github --event done \
  --title "deploy" \
  --reply "Workflow run #9182 succeeded in 4m 12s." \
  --origin-url "https://github.com/dwmkerr/signalbox/actions/runs/9182"

signalbox fire --agent script --event busy \
  --session-key script:demo --title "demo run" --tag demo
```

- Flags: `--agent` and `--event` (both required), `--reason`, `--title`, `--prompt`, `--reply`, `--session-key`, `--origin-url`, `--tag <t>` (repeatable), `--pid` (the agent process, for the hub's liveness sweep; `--pid-name` overrides the resolved name). Repeatable `--tag` fires one `tag` event immediately after the session event, carrying every tag and the same resolved session key, so `#tag` and `!tag` filters see it.
- A missing `--agent` or an unknown `--event` warns on stderr - one line naming the valid events (`attention`, `error`, `done`, `busy`, `ended`, `seen`, `hide`, `show`, `pin`, `unpin`, `label`, `tag`, `untag`) - and still exits 0. fire is called from agent adapters and user hooks, so a usage mistake must be visible but never fatal to the caller; delivery failures likewise spool and exit 0, so scripts never break on a down hub.
- Fired from inside tmux, the pane origin is captured automatically; from a VS Code / Cursor integrated terminal, an editor origin is captured instead, so `jump` can route back. tmux beats the editor check: a pane is a more precise jump target than an app window.
- `--prompt` and `--reply` are cropped at the emitter (160 and 280 characters, one line). The full text never leaves the process. `--detail` is accepted as an alias for `--prompt`. See the [data model](events.md).

`components/scripts/demo.sh` tags every session it seeds `demo`. Add `!demo` to
the app's Additional filters to hide those sessions without removing them.

## session - acting on a session

```bash
signalbox session ack claude:9f2a            # mark seen; the row stays, the flag clears
signalbox session hide claude:9f2a           # hide until the session speaks again
signalbox session show claude:9f2a           # unhide; the row reappears in place
signalbox session pin claude:9f2a            # pin to the top partition of the board
signalbox session unpin claude:9f2a          # remove the pin
signalbox session rename claude:9f2a deploy  # set your own name for the session
signalbox session rename claude:9f2a         # empty clears it
signalbox session remove claude:9f2a         # off the board now
signalbox session clear                       # every session off the board (start fresh)
signalbox session list                       # alias for state
signalbox session tag claude:9f2a work       # add a discreet tag
signalbox session untag claude:9f2a work     # remove it
```

Filter the board by tag: `signalbox state --tag work` (only tagged) or
`--exclude-tag work` (hide them).

In the app, **Settings → Additional filters** holds one or more terms (space-
separated), always applied to both the jumplist and the menu bar list. Same
grammar as the jumplist search: `#tag` matches a tag, plain text matches the
session name/title/agent/prompt, and a `!` prefix excludes either. `#work
!project` shows work sessions but hides anything named or tagged `project`.
Blank shows all. It applies live, persists, and lives in Settings only.

To relaunch straight into a filtered view, pass `--filter` on launch:

```bash
# restart filtered to the `work` tag
osascript -e 'quit app "Signalbox"'; open Signalbox.app --args --filter work
# restart showing everything again
osascript -e 'quit app "Signalbox"'; open Signalbox.app --args --filter
```

These are the CLI forms of the jumplist keys (`↩` ack-via-jump, `⌃X` hide, `⌃R` rename, `⌃⌫` remove).

## hub

Run the hub in the foreground. On macOS the menu bar app starts and supervises
one for you (quit the app and the hub stops with it). Run it yourself for
headless machines, CI, or development.

```bash
signalbox hub --port 8377                 # loopback only (default)
SIGNALBOX_TOKEN=... signalbox hub --bind 0.0.0.0   # serve other machines
SIGNALBOX_TOKEN=... signalbox hub --remote   # container/PaaS: platform TLS in front
signalbox hub --upstream https://my-hub.fly.dev   # forward to a remote hub
```

A running state-owning hub reports its runtime explicitly at the unauthenticated
`GET /healthz` endpoint: `{"ok": true, "version": "0.1.5", "build":
"d6907e1-dirty", "mode": "local", "bind": "127.0.0.1", "port": 8377}`.
`mode` is `local`, `lan`, or `remote` and is the single oracle for which runtime
is answering - callers must never infer it from `bind` or from other response
keys. `version` stays the bare semver, and `build` is empty on an unstamped
build. A forwarder instead reports `{"ok": true, "version": "0.1.5", "build":
"d6907e1-dirty", "mode": "forwarder", "port": 8377, "upstream": {"url":
"https://my-hub.fly.dev", "connected": true, "lastSeq": 118, "spooled": 0}}`.

```text
signalbox hub 0.1.0 listening on http://127.0.0.1:8377 (state: /Users/you/.local/state/signalbox, expire: 24h)
```

The hub writes its lifecycle lines to stderr, each prefixed
`YYYY-MM-DD HH:MM:SS` in local time. The macOS app redirects them to
`~/.local/state/signalbox/hub.log` and shows the last 500 lines in Settings >
Logs. A forwarder's uplink lines go to both `hub.log` and `cli.log`.

Binds `127.0.0.1` by default. `--bind <host>` (or `SIGNALBOX_BIND`; the flag wins) widens that. Outside remote mode, loopback peers still need no token, but every non-loopback client must send `Authorization: Bearer $SIGNALBOX_TOKEN`. The hub never serves a non-loopback bind without a configured token. Binding, auth, and the unauthenticated exemptions are specified in the [data model](events.md#binding-and-auth).

Outside remote mode, with no `--bind` and no `SIGNALBOX_BIND`, the hub falls back to the persisted `hub.bind` (see [config](#config)). So `signalbox config set hub.bind any` makes a bare `signalbox hub` come up reachable by other devices with a token, no flags or env needed. This also covers the hub the menu bar app spawns, which passes no flags. The resolution order is `--bind` flag, then `SIGNALBOX_BIND`, then `hub.bind`, then loopback; the token is `SIGNALBOX_TOKEN`, then `hub.token`. When the resolved bind is non-loopback and no token is set either way, the hub **generates a token, saves it to `hub.token`, and prints `signalbox: generated a hub token and saved it to <path>`** on stderr, so it stays reachable on a stable auto-token across restarts.

With an upstream, `hub` runs a forwarder: upstream resolution is `--upstream`, then `SIGNALBOX_UPSTREAM`, then persisted `hub.upstream`, and the upstream bearer is `SIGNALBOX_TOKEN`, then persisted `hub.token`. The URL must be an origin: no path other than `/`, no query, no fragment, no embedded credentials. Embedded credentials are refused because `GET /healthz` echoes the upstream URL verbatim on the unauthenticated loopback listener, while startup diagnostics and `signalbox config get` print it; accepting them would leak the credential to any local process or anyone who can read stderr or the config. The URL must use `https`, except that `http` is accepted for `localhost`, `127.x.x.x` and `::1`; accepted values are canonicalized to their URL origin. A missing token is a startup warning, not a failure, because an upstream at `localhost`, `127.x.x.x` or `::1` may legitimately be unauthenticated. An explicit `--bind` or non-empty `SIGNALBOX_BIND` is fatal with an upstream because a forwarder is an unauthenticated, local-trust listener and must never be told to face the network. `--remote` (or `SIGNALBOX_REMOTE`) with an upstream is also fatal. A persisted `hub.bind` is ignored; if it is non-loopback the forwarder prints one warning and still binds `127.0.0.1`. This only warns so an app-spawned hub does not refuse to boot when the user enables the forwarder while a non-loopback bind remains saved from an earlier state-owning setup. Local clients continue to see an unauthenticated loopback hub and need no token anywhere. Events are stored in the forward spool and sent with the resolved upstream bearer when one is set; state and stream reads come from the upstream downlink.

```text
signalbox hub 0.1.0 (forwarder) listening on http://127.0.0.1:8377 -> upstream https://my-hub.fly.dev; local clients need no token (state: /Users/you/.local/state/signalbox)
```

`signalbox hub --remote` is one switch with four inseparable effects: the default bind is `0.0.0.0`; `SIGNALBOX_TOKEN` is mandatory and is read from the environment only, never from the persisted `hub.token`; no self-signed TLS listener is created because the platform terminates TLS; and there is no loopback auth exemption at all because, behind a proxy, the peer address is the proxy's and proves nothing about the client. The hub refuses to start when the environment token is missing or empty and never generates one: an ephemeral container filesystem would lose it on redeploy and strand every paired phone. `SIGNALBOX_REMOTE=1` or `SIGNALBOX_REMOTE=true` is equivalent to `--remote`. `GET /healthz` and `POST /pair` remain the only unauthenticated routes.

```text
signalbox hub 0.1.0 (remote mode) listening on http://0.0.0.0:8377 - platform TLS assumed in front; EVERY request needs Authorization: Bearer (except /healthz and POST /pair) (state: /Users/you/.local/state/signalbox, expire: 24h)
```

The hub keeps the state of every session, streams changes to the surfaces, and runs two sweeps: expiry (no agent event for `SIGNALBOX_EXPIRE`, default 24h, ends the session) and liveness (an agent process that died without an exit event is ended within about 30 seconds). Endpoints and rules are in the [data model](events.md).

## pair

Pair a phone with the hub without ever putting the token on screen. By default, run it on the hub machine; with `--url`, run it from an administrator's machine holding the remote hub token. It mints a one-time code and prints a QR that encodes the hub URL, the code, and (when a pinned LAN listener is available) the cert pin, then waits for the phone to scan and redeem it.

```bash
signalbox pair                       # QR + code, then wait for the phone
signalbox pair --host 192.168.1.94   # force the advertised IP
signalbox pair --url https://my-hub.fly.dev   # pair against a remote hub
```

Beneath the QR it prints the plain `signalbox://pair?url=<hub-url>&code=<code>[&fp=<pin>]` link and the URL and code on their own lines for manual entry. The code is base64url and good for 180 seconds. The phone POSTs it to `/pair` and the hub trades it for the bearer token, which the phone stores; the token itself never appears on screen, in the QR, or in scrollback. `pair` polls `/pair/status` and prints `phone paired` once the phone redeems, or `code expired - run signalbox pair again` at timeout.

`--url` accepts an `https` hub origin. It rejects `http`, embedded credentials, a non-root path, a query, or a fragment, and the QR carries the URL's origin. `pair` mints at that origin with `Authorization: Bearer $SIGNALBOX_TOKEN`, errors up front with a message naming `SIGNALBOX_TOKEN` when the variable is unset or empty, and polls `/pair/status` on the same origin. A normal remote-mode mint has no `fp` or TLS `port`, so the QR advertises the supplied URL with no `fp`; the phone validates the platform's CA-issued certificate with system trust. If a mint does carry both `fp` and `port`, the pinned LAN target wins over `--url`, and only that complete pair causes the QR to carry `fp`.

**Pinned LAN TLS (#25).** Outside remote mode, when devices are allowed, the hub serves the phone over `https` with a persisted self-signed cert (`tls-cert.pem`/`tls-key.pem` in the state dir), on a listener one port above the loopback http port (e.g. `8378`). Local clients - the menu bar app, CLI, adapters - keep plain http on loopback, untouched. The QR's `url` is `https://<ip>:<tls-port>` and `fp` is the SHA-256 of the cert's DER, which the phone pins: an attacker presenting any other cert fails the pin, so a self-signed cert with no CA still gives MITM-proof transport with no user ceremony. If `openssl` is unavailable the hub cannot mint a cert and falls back to plain http (no `fp`), pairing over http as before. A hand-entered hub in the app's Settings is http and carries no pin.

Pairing requires a hub with a non-loopback bind and a configured token: a hub bound to loopback, which no phone could reach, refuses to mint, and so does a hub with no token. For LAN pairing, the advertised host is the hub's bind when that is a concrete IP, otherwise this machine's LAN IPv4 (VPN and tunnel interfaces are skipped so a corp VPN address never wins); `--host` overrides. Minting a code and reading pairing status require a loopback peer or a valid bearer because a token holder is already fully trusted: they can read every prompt and forge events, so a loopback gate bought nothing and blocked the legitimate remote-admin flow. In remote mode the loopback half never applies, so the bearer is always required. The endpoints (`POST /pair`, `POST /pair/new`, `GET /pair/status`) and the full security rationale are in the [data model](events.md#pairing).

On a forwarder, `POST /pair`, `POST /pair/new` and `GET /pair/status` all return `409` with a message naming `signalbox pair --url <upstream>`. A forwarder owns neither the state nor the pairing token.
The macOS Connect Phone window therefore never asks the forwarder to mint: it
mints against the upstream origin itself, exactly as `pair --url` does (`POST
<upstream>/pair/new` with `Authorization: Bearer` from the stored `hub.token`),
shows the QR in the window, and polls `<upstream>/pair/status` with the same
bearer. A remote mint carries no `fp` or TLS `port`, so the QR advertises the
upstream origin with no pin. When it cannot mint - no upstream address, no
stored token, a rejected token, or an unreachable hub - the window falls back to
the copyable `signalbox pair --url <upstream>` command with the reason.

## config

Persist how the hub binds or which upstream it forwards to, so it needs no flags or env. Values live in the settings file (`$XDG_CONFIG_HOME/signalbox/settings.json`, else `~/.config/signalbox/settings.json`; `SIGNALBOX_CONFIG` or the global `--config <path>` flag point at a different file) under a `hub` section and are read by every `signalbox hub` start (the [hub](#hub) section covers the resolution orders and the auto-token). A tiny three-key surface (`hub.bind`, `hub.token`, `hub.upstream`); the app owns everything else in that file.

```bash
signalbox config get                          # the effective hub config
signalbox config set hub.bind any             # let other devices connect (binds 0.0.0.0)
signalbox config set hub.bind loopback        # back to this Mac only (binds 127.0.0.1)
signalbox config set hub.bind 192.168.1.94    # an explicit address
signalbox config set hub.token <value>        # set the bearer token
signalbox config set hub.token --generate     # mint and store a random token
signalbox config set hub.token ""             # empty value also mints one
signalbox config set hub.upstream https://my-hub.fly.dev   # run as a forwarder
signalbox config set hub.upstream ""          # clear it and own state locally
```

```text
hub.bind:  0.0.0.0 (other devices may connect; this Mac is reachable at 192.168.1.94)
hub.token: set
hub.upstream: https://my-hub.fly.dev
```

`hub.bind` is stored as a literal address: what you set is what the hub binds. On `config set`, a few words are accepted as conveniences and normalized before saving:

- `loopback` or `local` store `127.0.0.1` (this Mac only).
- `any` or `all` store `0.0.0.0` (every interface, so other devices and anything on a VPN can connect).
- An explicit IP is stored verbatim.
- `lan` is refused with `"lan" is ambiguous: use "any" (all interfaces, incl. VPN) or a specific IP`, since a wildcard bind also answers VPN interfaces.

The `0.0.0.0` wildcard is preferred over a single pinned interface IP because the hub must keep answering loopback (local hooks and the menu bar app reach it there), and a fixed IP goes stale when DHCP moves the machine. For a wildcard bind, `config get` adds the LAN IPv4 a device would actually dial. `config get` prints only `set` or `none` for the token. Setting a non-loopback `hub.bind` does not itself write a token; the next `signalbox hub` generates and saves one (see [hub](#hub)).

`hub.upstream` accepts the same origin-only URL as `hub --upstream`: `https`, or plain `http` only for `localhost`, `127.x.x.x` or `::1`. Saving canonicalizes it to the URL origin. An empty value clears it; a non-empty value makes a bare or app-spawned `signalbox hub` run as a forwarder.

The app also writes `hub.remoteUrl` into the same section: the remote hub address it last confirmed, remembered so its Hub tab can offer it again. Nothing in the CLI reads it and it is not settable (`config set hub.remoteUrl` is an unknown key), because `hub.upstream` alone decides whether this hub forwards - switching the app to Local or LAN empties `hub.upstream` while `hub.remoteUrl` keeps the address for the next switch back. Like every app-owned key it survives `config set` untouched.

## hook and plumbing

- `signalbox hook claude` - reads a Claude Code hook payload on stdin and fires the mapped event ([agent integrations](adapters.md)).
- `signalbox hook cursor` - reads a Cursor hook payload on stdin and fires the mapped event ([agent integrations](adapters.md)). Available (Cursor Hooks are beta upstream).
- `signalbox hook codex` - reads a Codex hook payload on stdin and fires the mapped event ([agent integrations](adapters.md)). Needs `[features] hooks = true` in `~/.codex/config.toml`.
- `signalbox tmux seen-pane --socket S --pane P` - for tmux's `pane-focus-in` hook: looking at a pane clears its flag, exactly like jumping to it.
- `signalbox drain` - flush the offline spool. Every event-sending command drains opportunistically before posting, so this is rarely needed by hand.

The flat forms (`signalbox ack`, `signalbox claude-hook`, `signalbox tmux-status`, …) still work as aliases, and `install`/`setup` are aliases for `init`, so existing configs keep running.

Delivery from all hook-path commands is one POST with a 200ms timeout; on failure the event spools to disk and the next invocation delivers it (the opportunistic drain is bounded to 100 events and 2s, so a backlog can never stall the hook path). No daemon on the hook path, no waiting.

## version

```bash
signalbox version      # 0.1.5 (d6907e1-dirty)
```

The bare semver, plus the build provenance in parentheses when the binary was
stamped at compile time. `make build` stamps `git describe --always --dirty
--tags`; release CI stamps the release tag; an unstamped build (a plain
`bun run src/main.ts`) prints the semver alone. The same provenance appears in
the hub's startup log line and in `GET /healthz` as the separate `build` field,
while `version` remains the bare semver, so "which build is this hub" has one
answer everywhere.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SIGNALBOX_URL` | `http://127.0.0.1:8377` | hub address |
| `SIGNALBOX_DATA_DIR` | `~/.local/state/signalbox` | spool, log, events.jsonl |
| `SIGNALBOX_CONFIG` | `$XDG_CONFIG_HOME/signalbox/settings.json`, else `~/.config/signalbox/settings.json` | path to the settings FILE (not a directory); the global `--config <path>` flag wins over it |
| `SIGNALBOX_PROFILE` | `full` | `redacted` drops cwd, title, prompt and reply, and hashes the session id |
| `SIGNALBOX_EXPIRE` | `24h` | hub: end sessions with no agent event for this long |
| `SIGNALBOX_BIND` | `127.0.0.1` | hub: bind address (`signalbox hub --bind` wins over it) |
| `SIGNALBOX_UPSTREAM` | unset | hub: forward to this remote hub instead of owning state (`signalbox hub --upstream` wins) |
| `SIGNALBOX_REMOTE` | unset | hub: `1` or `true` runs the hub in remote mode (same as `--remote`) |
| `SIGNALBOX_TOKEN` | unset | bearer token: required to bind non-loopback, and sent by clients as `Authorization: Bearer` |
| `SIGNALBOX_RAW` | unset | diagnostic: `hook claude` / `hook cursor` attach the untouched hook payload to the fired event (stripped by the redacted profile) |
