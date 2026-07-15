signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | [cli](cli.md) | [data model](events.md) | agent integrations

# Specification: signalbox agent integrations

How each coding agent connects to signalbox, and how its hooks map to events. Adapters live in `components/cli/adapters/`.

Installing: `signalbox init` converges everything ([cli.md](cli.md); `install` and `setup` are aliases); `signalbox init --agent <name>` (repeatable, `--agent all` for every agent) scopes the run to one or more agents and applies without the picker; `--remove` turns the same components off. `--app` and `--tmux` scope to the other components.

## Claude Code (`signalbox hook claude`, stdin JSON)

Install:

```bash
signalbox init --agent claude
```

`init` merges the JSON block into `~/.claude/settings.json` with consent (timestamped backup, atomic parse-validated write; declining prints the block to apply by hand). Detection is forgiving: an event whose hook routes through a wrapper script counts as present - merging there would double-fire every hook, so wrapper-routed events are never touched. `--remove` reverses the edit, removing only the literal signalbox commands.

```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }]
  }
}
```

| Hook input | Event |
|---|---|
| `SessionStart` | busy (reason `session_start`) |
| `UserPromptSubmit` | busy + `prompt` = cropped prompt text |
| `Stop` | done (reason `stop`) |
| `Notification` - idle | done (reason `idle`). Matched by `notification_type: idle_prompt`, or (current Claude Code sends no type) by a typeless `message` mentioning idle/finished/"waiting for your input"/"no longer" (case-insensitive). |
| `Notification` - anything else (permission prompt, elicitation, unknown type, or a typeless permission `message`) | attention. Claude is blocked waiting on you. Defaulting to attention keeps the "needs you" state honest across Claude Code versions that change these payloads. |
| `StopFailure` | error (reason = `error_type`) |
| `SessionEnd` | ended - except reason `clear` when the `claudeClearEnds` setting is off, which maps to done (reason `clear`) so the old exchange stays on the board ([settings.html](https://dwmkerr.github.io/signalbox/specs/settings.html)) |
| anything else | ignore, exit 0 |

- `session_key = claude:<session_id>`.
- Title: explicit `/rename` from the transcript's `custom-title` entries (bounded head+tail read, last one wins) beats the cwd basename. The `claudeRenameTitle` setting turns the `/rename` lookup off; your own jumplist rename (a label event) overrides either.
- `reply`: final assistant text from the transcript (bounded tail read of `transcript_path`, never the full file). Captured on `Stop` and on **any idle notification** - by the same idle test the mapping uses, so a typeless idle `message` on current Claude Code refreshes the reply just like a typed `idle_prompt`. **Not** captured on permission/attention notifications, where the transcript's last line is stale. Filtered like the prompt; empty on any miss, so the previous reply carries.
- Prompt filter (shared with reply): strip leading bracket-tag prefixes (`[Image #1]` etc.); skip text that then starts with `<` (harness XML) - detail is the last *human* prompt.
- Hooks run under a transient shell (`sh -c`, or a dispatcher script), so the hook's parent is walked past shell wrappers (bounded) to the agent process, captured as `proc` for the liveness sweep.
- `SIGNALBOX_RAW` (diagnostic, off by default): attaches the untouched hook payload to the event as `raw`, so it can be inspected in the hub's own event log (`state --json` / events.jsonl). Stripped by the redacted profile; never sent in normal operation. Applies to `hook cursor` too.

## Cursor (`signalbox hook cursor`, stdin JSON) - (available, still in testing)

Cursor's own agent (Composer / Agent), via [Cursor 1.7 Hooks](https://cursor.com/docs/hooks) (beta). Agents you run in Cursor's *integrated terminal* (claude, opencode, pi) already fire their own hooks - this adapter is for Cursor's built-in agent.

Install:

```bash
signalbox init --agent cursor
```

`init` merges the block into `~/.cursor/hooks.json` with consent (backup + atomic write, like Claude's; wrapper-routed hooks count as present and are never touched). The block, to apply by hand if you decline:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "signalbox hook cursor" }],
    "stop": [{ "command": "signalbox hook cursor" }],
    "subagentStop": [{ "command": "signalbox hook cursor" }],
    "beforeShellExecution": [{ "command": "signalbox hook cursor" }],
    "beforeMCPExecution": [{ "command": "signalbox hook cursor" }]
  }
}
```

| Hook input | Event |
|---|---|
| `sessionStart` | busy (reason `session_start`) |
| `stop`, `status: completed` (or missing/unknown) | done (reason `stop`) |
| `stop`, `status: aborted` | ended (reason `aborted`) |
| `stop`, `status: error` | error (reason `error`) |
| `beforeShellExecution` | attention (reason `shell_permission`) - the ask/permission path, Cursor's only "blocked on you" signal |
| `beforeMCPExecution` | attention (reason `mcp_permission`) |
| `subagentStop` | done (reason `subagent_stop`) |
| anything else (`subagentStart`, `afterFileEdit`, …) | ignore, exit 0 |

- `session_key = cursor:<conversation_id>`.
- Title and `cwd`: `workspace_roots[0]` (basename is the title).
- `reply`: best-effort from `transcript_path` on stop/subagentStop, **transcript format unverified** - returns empty (and the previous reply carries) if it does not match the assumed JSONL shape.
- `proc` and `SIGNALBOX_RAW` behave as for Claude (shell-wrapper walk to the agent process; raw-payload diagnostic).
- Jump-back raises the **Cursor window** for the workspace (bundle id `com.todesktop.230313mzl4w4u92`, plus an Accessibility `AXRaise` on the window whose title contains the project folder). **Window-level only** - Cursor's editor/terminal tabs are not externally addressable, so a specific Composer tab cannot be targeted.
- **Cursor Hooks are beta**: event names, payload fields (`status`, `transcript_path`, `workspace_roots`) and the permission-signal behaviour should be confirmed against a live Cursor; the mapping degrades safely if they shift.

## VS Code - terminal jump-back - (available, still in testing)

No adapter and no config. Agents you run in VS Code's *integrated terminal* (claude, opencode, pi) already fire their own hooks; signalbox detects the editor terminal automatically (`TERM_PROGRAM=vscode`, set by VS Code on every terminal process) and captures an editor origin. Jump then raises the VS Code window for the project (`open -b com.microsoft.VSCode` plus a best-effort Accessibility `AXRaise` on the window whose title contains the workspace folder). **Window-level only** - VS Code's editor/terminal tabs are not externally addressable, the same limitation as Cursor.

- Cursor's integrated terminal is detected the same way (Cursor is a VS Code fork and also sets `TERM_PROGRAM=vscode`); the two are told apart by the process's `__CFBundleIdentifier`, defaulting to VS Code when it is absent. Other forks pass their own bundle id through.
- A tmux pane inside the editor terminal still wins: the pane is the more precise jump target.
- VS Code's *own* agent (Copilot Chat / agent mode) has no external hook system, so there is no event adapter for it - terminal jump-back is the whole VS Code surface for now.

## tmux - in-terminal signals and jump-back

Not an agent: tmux is where agents run. `signalbox init --tmux` prints this snippet to add to `~/.tmux.conf` by hand (your config file, never merged; every line no-ops when signalbox is not installed):

```tmux
set -g status-interval 2
set -g status-right '#(command -v signalbox >/dev/null && signalbox tmux status)  %Y-%m-%d %H:%M'
bind-key j display-popup -E -w 80% -h 15 "command -v signalbox >/dev/null && signalbox pick || echo signalbox is not installed"
set-hook -g pane-focus-in 'run-shell -b "command -v signalbox >/dev/null 2>&1 && signalbox tmux seen-pane --socket #{socket_path} --pane #{pane_id} || true"'
```

- Origin capture: any hook fired from a tmux pane records session/window/pane (our own 🔔 suffix stripped from the session name), the server socket, and the terminal app's bundle id (`__CFBundleIdentifier`) - everything jump needs, captured at fire time. The pane beats the editor-terminal check above.
- In-terminal signals ride every fire, hub or no hub: attention/done/error ring the bell, set an amber pane background and suffix the session name with 🔔; busy/ended clear all three.
- Detection (`init`): signalbox in the *running* server's `status-right` counts as set up (options set live never touch a file), as does either `~/.tmux.conf` or the XDG `~/.config/tmux/tmux.conf`.

## OpenCode (plugin, `components/cli/adapters/opencode/signalbox.js`)

Install:

```bash
signalbox init --agent opencode
```


`session.status busy|retry` → busy (reason `retry` when retrying) · `session.idle` → done · `permission.asked` (or `permission.updated`, which opencode 1.17 emits for the same signal) → attention (reason `permission_prompt`) · `session.error` → error (reason = the error's name) · `session.deleted` → ended.
`session_key = opencode:<sessionID>`; title from session info (cwd basename fallback); detail = last user prompt and reply = last assistant text part, both cached from the message events and cropped at the emitter.

## pi (extension, `components/cli/adapters/pi/signalbox.ts`)

Install:

```bash
signalbox init --agent pi
```


`agent_start` → busy · `agent_end` → done · `session_shutdown` → ended.
`session_key = pi:<session id>`; title = pi's session name (cwd basename fallback); detail = the last prompt, cached from the `input` event (`agent_start` carries no payload); reply from `agent_end`'s messages. pi exposes no error or permission events, so a pi session never shows error or attention - busy/done/ended is its whole vocabulary.

**Serialize fires** in any adapter that spawns the CLI per event: spawn the next CLI only after the previous exits. The hub applies events in arrival order, and `agent_end`/`session_shutdown` fire back-to-back - concurrent processes could deliver `ended` before `done` and resurrect a removed session. These in-process adapters (opencode, pi) also pass their own `--pid`/`--pid-name` on every fire, so the hub's liveness sweep can end sessions whose agent died without an exit event.

## GitHub Actions (any remote job)

No adapter needed - the CLI is the adapter:

```yaml
- run: |
    signalbox fire --agent github --event done \
      --session-key "github:${GITHUB_REPOSITORY}/ci" \
      --title "my workflow" \
      --reply "Build complete." \
      --origin-url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
```

The `--origin-url` makes the row jumpable: Enter opens the run in the browser. See `.github/workflows/ci.yml` (the `signal` job) for the living example.
