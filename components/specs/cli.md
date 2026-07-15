signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | cli | [data model](events.md) | [agent integrations](adapters.md)

# Specification: signalbox CLI

signalbox is a single binary. The commands agents call on the hook path (`fire`, `hook claude`, `hook cursor`, `tmux seen-pane`, and the `session` verbs `ack`, `hide`, `rename`, `remove`, `tag`, `untag`) are strictly bounded - one POST with a 200ms timeout, a capped backlog drain - and always exit 0, so a notifier can never break the agent that called it. The commands you run yourself (`state`, `jump`, `pick`, `init`, `hub`, `drain`) may fail loudly.

Bare `signalbox` (and `-h`/`--help`) prints a short help: just the human commands. `signalbox help` is the full reference - every command, flag, and environment variable. When a command needs the hub and it is not running, the error names the fix (open the Signalbox app, or `signalbox hub`).

## init

Guided, idempotent setup. One board, rendered two ways: on a terminal it opens
an interactive picker; piped, `--status`, `--yes`, or `-v` it prints the same
board read-only. The checkbox is the *desired* state and starts at what's
installed, so init is the way both in and out - check a missing component to set
it up, uncheck an installed one to remove it, `⏎` applies. `d` shows details.

`-v`/`--verbose` adds install paths to each row. Verbose only affects the status
view (the picker never shows paths), so `-v` implies the read-only status board
even on a terminal - plain `signalbox init -v` shows the board with paths, not
the picker.

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

`●` is set up, `○` is not (with what it costs you). When everything is green the last line points at the jumplist: "Everything is set up. Press `⌃⌥J` to jump between sessions." In the picker a checked-but-
missing row shows `◉ · set up` and an unchecked-but-installed row shows `○ · remove`.

User config policy: JSON agent configs (`~/.claude/settings.json`,
`~/.cursor/hooks.json`) are merged only with consent - checking the row in
the picker or passing the scope flag IS the consent - with a timestamped
backup next to the file and an atomic, parse-validated write. Only events
with no hooks at all are filled; hooks routed through your own wrapper are
never touched (and never doubled). `--remove` is the same edit in reverse:
only the literal `signalbox hook <agent>` commands are removed. Freeform
config (`~/.tmux.conf`) is never edited - the exact snippet is printed
instead. The binary itself is not init's business: Homebrew owns the CLI on
PATH, and the menu bar app owns the hub. Pass `--yes` to apply
non-interactively.

Scope it to one component when you do not want the whole board. Add `--remove`
to turn that component off instead of on:

```bash
signalbox init --agent claude          # just wire Claude Code
signalbox init --agent cursor          # wire Cursor's own agent (available, still in testing)
signalbox init --agent claude --agent pi   # wire two agents
signalbox init --app                   # open the menu bar app (it runs the hub)
signalbox init --tmux                  # just print the tmux snippet
signalbox init --remove --agent pi     # unlink the pi extension
signalbox init --remove --app          # quit the app (the hub stops with it)
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

For a tmux origin this switches the right tmux server to the exact pane and raises the terminal window it lives in. For a URL origin (a CI run, for example) it opens the browser - http/https only, anything else is refused. For an editor origin (Cursor's own agent, or an agent in a VS Code / Cursor integrated terminal) it activates the editor by bundle id and best-effort raises the window matching the workspace folder - window-level, not tab-level, because editor tabs are not externally addressable. Everything jump needs was captured when the event fired - it never guesses at your local setup.

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

It never hangs (200ms timeout) and never errors visibly - a dead hub renders as an empty segment.

`signalbox init` reports the tmux integration as set up when it finds signalbox in the running tmux server's `status-right` (set live with `set-option`, not only in a file), or in `~/.tmux.conf` or `~/.config/tmux/tmux.conf` (the XDG path). Detection matches what tmux is actually running, not just one config file.

## fire

Fire an event. This is how anything that is not a supported coding agent gets on the board - scripts, cron jobs, CI.

```bash
signalbox fire --agent github --event done \
  --title "deploy" \
  --reply "Workflow run #9182 succeeded in 4m 12s." \
  --origin-url "https://github.com/dwmkerr/signalbox/actions/runs/9182"
```

- Flags: `--agent` and `--event` (both required), `--reason`, `--title`, `--prompt`, `--reply`, `--session-key`, `--origin-url`, `--pid` (the agent process, for the hub's liveness sweep; `--pid-name` overrides the resolved name).
- Fired from inside tmux, the pane origin is captured automatically; from a VS Code / Cursor integrated terminal, an editor origin is captured instead - so `jump` can route back. tmux beats the editor check: a pane is a more precise jump target than an app window.
- `--prompt` and `--reply` are cropped at the emitter (160 and 280 characters, one line). The full text never leaves the process. `--detail` is accepted as an alias for `--prompt`. See the [data model](events.md).

## session - acting on a session

```bash
signalbox session ack claude:9f2a            # mark seen; the row stays, the flag clears
signalbox session hide claude:9f2a           # hide until the session speaks again
signalbox session rename claude:9f2a deploy  # set your own name for the session
signalbox session rename claude:9f2a         # empty clears it
signalbox session remove claude:9f2a         # off the board now
signalbox session list                       # alias for state
signalbox session tag claude:9f2a work       # add a discreet tag
signalbox session untag claude:9f2a work     # remove it
```

Filter the board by tag: `signalbox state --tag work` (only tagged) or
`--exclude-tag work` (hide them).

In the app, **Settings → Additional filters** holds one or more terms (space-
separated), always applied to both the jumplist and the menu bar list. Same
grammar as the jumplist search: `#tag` matches a tag, plain text matches the
session name/title/agent/prompt, and a `!` prefix excludes either - `#work
!project` shows work sessions but hides anything named or tagged `project` (keep
a project off a recording). Blank shows all. It applies live and persists, and
lives in Settings only - an advanced knob, not a button in the way for the
common untagged case.

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
one for you (quit the app and the hub stops with it) - run it yourself for
headless machines, CI, or development.

```bash
signalbox hub --port 8377
```

```text
signalbox hub 0.1.0 listening on http://127.0.0.1:8377 (state: /Users/you/.local/state/signalbox, expire: 24h)
```

Loopback only. The hub keeps the state of every session, streams changes to the surfaces, and runs two sweeps: expiry (no agent event for `SIGNALBOX_EXPIRE`, default 24h, ends the session) and liveness (an agent process that died without an exit event is ended within about 30 seconds). Endpoints and rules are in the [data model](events.md).

## hook and plumbing

- `signalbox hook claude` - reads a Claude Code hook payload on stdin and fires the mapped event ([agent integrations](adapters.md)).
- `signalbox hook cursor` - reads a Cursor hook payload on stdin and fires the mapped event ([agent integrations](adapters.md)). Available, still in testing (Cursor Hooks are beta).
- `signalbox tmux seen-pane --socket S --pane P` - for tmux's `pane-focus-in` hook: looking at a pane clears its flag, exactly like jumping to it.
- `signalbox drain` - flush the offline spool. Every event-sending command drains opportunistically before posting, so this is rarely needed by hand.

The flat forms (`signalbox ack`, `signalbox claude-hook`, `signalbox tmux-status`, …) still work as aliases, and `install`/`setup` are aliases for `init`, so existing configs keep running.

Delivery from all hook-path commands is one POST with a 200ms timeout; on failure the event spools to disk and the next invocation delivers it (the opportunistic drain is bounded - 100 events, 2s - so a backlog can never stall the hook path). No daemon on the hook path, no waiting.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SIGNALBOX_URL` | `http://127.0.0.1:8377` | hub address |
| `SIGNALBOX_STATE_DIR` | `~/.local/state/signalbox` | spool, log, events.jsonl |
| `SIGNALBOX_PROFILE` | `full` | `redacted` drops cwd, title, prompt and reply, and hashes the session id |
| `SIGNALBOX_EXPIRE` | `24h` | hub: end sessions with no agent event for this long |
| `SIGNALBOX_RAW` | unset | diagnostic: `hook claude` / `hook cursor` attach the untouched hook payload to the fired event (stripped by the redacted profile) |
