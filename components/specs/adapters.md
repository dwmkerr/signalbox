signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | [ios](https://dwmkerr.github.io/signalbox/specs/ios.html) | [architecture](https://dwmkerr.github.io/signalbox/specs/architecture.html) | [cli](cli.md) | [data model](events.md) | agent integrations | [agent markdown](agent-markdown.md)

# Specification: signalbox agent integrations

How each coding agent connects to signalbox, and how its hooks map to events. Adapters live in `components/cli/adapters/`.

Every adapter passes the agent's raw markdown without flattening it. The CLI's
event builder applies the shared caps (1,024 characters for prompts and 10,240
for replies) and sets `cropped`. The out-of-process OpenCode and pi plugins cut
only at those same caps before building argv, then pass `--cropped` so the event
builder preserves the marker.

## What each agent surfaces

An adapter can only surface what its agent's hooks emit, so the board shows different depth per agent. This is the user-facing summary; the per-agent sections below have the exact hook mapping. `-` means the agent has no hook for it, not a signalbox gap.

| Agent | Live status | Prompt + reply | Permission ask | Question ask | Errors | Jump-back |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Claude Code | yes | yes | command shown | yes, with options | yes | tmux / editor / iTerm |
| Codex | yes | yes | command shown | - | - `*` | tmux / Cursor / iTerm |
| Cursor | yes | yes | yes (shell / MCP) | - | yes | Cursor window |
| OpenCode | yes | yes | yes | - | yes | tmux / iTerm |
| pi | yes | yes | - | - | - | tmux / iTerm |
| GitHub Actions | as fired | as fired | - | - | yes (fire) | opens on GitHub |

- **Question ask** is Claude Code's `AskUserQuestion` (the agent asks you to pick an option); no other agent has an equivalent tool, so the column is Claude-only by nature.
- `*` **Codex has no error hook.** Its hook set is `session_start, user_prompt_submit, stop, permission_request, session_end` - there is no turn-failure event, so a Codex turn that errors just stops emitting and the row ages out via the liveness sweep rather than showing an error. Surfacing it would mean inferring failure from silence, which is worse than an honest gap. Not a bug to fix here - it needs an upstream Codex hook.

Installing: `signalbox init` converges everything ([cli.md](cli.md); `install` and `setup` are aliases); `signalbox init --agent <name>` (repeatable, `--agent all` for every agent) scopes the run to one or more agents and applies without the picker; `--remove` turns the same components off. `--app` and `--tmux` scope to the other components.

## Where adapters send events

Every adapter posts to `SIGNALBOX_URL`, which defaults to the trusted loopback endpoint `http://127.0.0.1:8377` and needs no token. That endpoint may be the hub that owns the state or a forwarder relaying to a remote hub; the adapter cannot tell and does not need to.

Do not give an adapter a bearer token. Copying the upstream credential into every hook environment is the leak the forwarder exists to close: the forwarder keeps it in one place and presents the same unauthenticated loopback contract to every local adapter.

## Claude Code (`signalbox hook claude`, stdin JSON)

Install:

```bash
signalbox init --agent claude
```

`init` merges the JSON block into `~/.claude/settings.json` with consent (timestamped backup, atomic parse-validated write; declining prints the block to apply by hand). Presence is read from the literal `signalbox hook claude` command, never guessed from a script name: an event that lacks it gets signalbox appended alongside whatever is already there. Hook arrays compose - every entry in an event fires - so an existing hook is never assumed to be signalbox and never rewritten, and appending alongside it cannot double-fire signalbox. `--remove` reverses the edit, removing only the literal signalbox commands.

```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "PreToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }]
  }
}
```

| Hook input | Event |
|---|---|
| `SessionStart` | busy (reason `session_start`) |
| `UserPromptSubmit` | busy + `prompt` = the raw prompt text + `reply` = the previous turn's final assistant text when present. Claude's transcript is append-only, so by the next prompt the previous final entry is guaranteed to be available. |
| `Stop` | done (reason `stop`) |
| `Notification` - idle | done (reason `idle`). Matched by `notification_type: idle_prompt`, or (current Claude Code sends no type) by a typeless `message` mentioning idle/finished/"waiting for your input"/"no longer" (case-insensitive). |
| `Notification` - anything else (permission prompt, elicitation, unknown type, or a typeless permission `message`) | attention. Claude is blocked waiting on you. Defaulting to attention keeps the needs-you state correct across Claude Code versions that change these payloads. On versions with `PermissionRequest` this is the bare duplicate of an enriched ask (the reducer's no-clobber rule keeps the rich one); on older versions it is the whole signal, exactly as before. |
| `PermissionRequest` (any tool) | attention (reason `permission_request`) + `reply` = the actual ask, formatted from `tool_name` and `tool_input` (e.g. `Bash: git push origin main`). Fires when the permission dialog appears, so this is the authoritative blocked-on-you signal with content. Older Claude Code ignores the unknown hook key and degrades to the bare Notification - no fallback machinery needed. |
| `PreToolUse`, matcher `AskUserQuestion` | attention (reason `question`) + `reply` = the question and its option labels (e.g. `Which auth approach? (JWT / sessions / magic links)`). AskUserQuestion is always interactive, so PreToolUse firing IS the dialog appearing - the question never reaches the transcript or the Notification payload while it waits, so this hook is the only passive source of the question text. The matcher keeps the hook off every other tool call: PreToolUse fires for all tools including auto-approved ones, and an unmatched registration would tax every tool call with a hook spawn to no benefit. |
| `StopFailure` | error (reason = `error_type`) |
| `SessionEnd` | ended - except reason `clear` when the `claudeClearEnds` setting is off, which maps to done (reason `clear`) so the old exchange stays on the board ([settings.html](https://dwmkerr.github.io/signalbox/specs/settings.html)) |
| anything else | ignore, exit 0 |

- `session_key = claude:<session_id>`.
- Host prefix (display only): when the hook fires from an editor's *integrated terminal* the displayed `agent` gains the editor host as a prefix - `cursor/claude` in Cursor, `vscode/claude` in VS Code (and unrecognized VS Code forks). The same `TERM_PROGRAM=vscode` + `__CFBundleIdentifier` check as the [VS Code terminal jump-back](#vs-code---terminal-jump-back---available-still-in-testing) below tells them apart; a plain terminal keeps the bare `claude`. The prefix drives the icon only (the editor's mark with Claude's glyph badged bottom-right). `session_key` stays `claude:<session_id>`, keyed on the agent family, so the same session stays on one row across a plain terminal and an editor.
- Title: explicit `/rename` from the transcript's `custom-title` entries (bounded head+tail read, last one wins) beats the cwd basename. The `claudeRenameTitle` setting turns the `/rename` lookup off; your own jumplist rename (a label event) overrides either.
- `reply`: final assistant text from the transcript (bounded tail read of `transcript_path`, never the full file). Captured on `Stop` and on **any idle notification** - by the same idle test the mapping uses, so a typeless idle `message` on current Claude Code refreshes the reply just like a typed `idle_prompt`. **Not** captured on permission/attention notifications, where the transcript's last line is stale. Filtered like the prompt; empty on any miss, so the previous reply carries.
- Prompt filter (shared with reply): strip leading bracket-tag prefixes (`[Image #1]` etc.); skip text that then starts with `<` (harness XML) - detail is the last *human* prompt.
- Ask formatting: `reply` for an ask is still formatted at the emitter (never file contents; a `Write`/`Edit` input is summarized to its path), but it is no longer cropped there. Cropping happens once in the event builder against the configured caps.
- Ask dedup: one dialog can produce both a `PermissionRequest` and a `Notification`. Both map to attention for the same session; the reducer's no-clobber rule ([events.md](events.md)) keeps the enriched reply regardless of arrival order.
- Hooks run under a transient shell (`sh -c`, or a dispatcher script), so the hook's parent is walked past shell wrappers (bounded) to the agent process, captured as `proc` for the liveness sweep.
- `SIGNALBOX_RAW` (diagnostic, off by default): attaches the untouched hook payload to the event as `raw`, so it can be inspected in the hub's own event log (`state --json` / events.jsonl). Stripped by the redacted profile; never sent in normal operation. Applies to `hook cursor` too.

## Cursor (`signalbox hook cursor`, stdin JSON)

Cursor's own agent (Composer / Agent), via [Cursor 1.7 Hooks](https://cursor.com/docs/hooks) (beta). Agents you run in Cursor's *integrated terminal* (claude, opencode, pi) already fire their own hooks - this adapter is for Cursor's built-in agent.

Install:

```bash
signalbox init --agent cursor
```

`init` merges the block into `~/.cursor/hooks.json` with consent (backup + atomic write, like Claude's; presence is the literal `signalbox hook cursor` command, and signalbox is appended alongside any existing hooks, never assuming they are ours). The block, to apply by hand if you decline:

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
| `beforeShellExecution` | attention (reason `shell_permission`) - the ask/permission path, Cursor's only blocked-on-you signal |
| `beforeMCPExecution` | attention (reason `mcp_permission`) |
| `subagentStop` | done (reason `subagent_stop`) |
| anything else (`subagentStart`, `afterFileEdit`, …) | ignore, exit 0 |

- `session_key = cursor:<conversation_id>`.
- Title and `cwd`: `workspace_roots[0]` (basename is the title).
- `prompt` and `reply` come from `transcript_path` on stop/subagentStop (Cursor has no prompt-submit hook, so neither is in the payload). Verified shape: `~/.cursor/projects/<ws>/agent-transcripts/<id>/<id>.jsonl`, one JSON object per line, `{role:"user"|"assistant", message:{content:[{type:"text", text}]}}` - role at the top level. `reply` = last assistant text; `prompt` = last user text, unwrapped from its `<user_query>...</user_query>` tag (a `<timestamp>` tag precedes it). Returns empty (previous value carries) on any mismatch.
- `proc` and `SIGNALBOX_RAW` behave as for Claude (shell-wrapper walk to the agent process; raw-payload diagnostic).
- Jump-back raises the **Cursor window** for the workspace (bundle id `com.todesktop.230313mzl4w4u92`, plus an Accessibility `AXRaise` on the window whose title contains the project folder). **Window-level only** - Cursor's editor/terminal tabs are not externally addressable, so a specific Composer tab cannot be targeted.
- **Cursor Hooks are beta**: event names, payload fields (`status`, `transcript_path`, `workspace_roots`) and the permission-signal behaviour should be confirmed against a live Cursor; the mapping degrades safely if they shift.

## Codex (`signalbox hook codex`, stdin JSON)

OpenAI's Codex CLI, via [Codex hooks](https://github.com/openai/codex) (needs `[features] hooks = true` in `~/.codex/config.toml`). Codex hooks mirror Claude Code's: JSON on stdin, snake_case fields, a PascalCase `hook_event_name`.

`init --agent codex` prints a `~/.codex/hooks.json` block to merge by hand; signalbox never edits your config. Hooks coexist, so signalbox's block sits alongside any others (e.g. a security tool's) and Codex fires them all. Codex records a trust hash for a new hook on first run.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }]
  }
}
```

| Hook | Event |
|---|---|
| `SessionStart` | busy (reason `session_start`) - the session appears while Codex boots. |
| `UserPromptSubmit` | busy - you sent a prompt and Codex is working; `detail` is that prompt (harness/bracket-tag filtered like Claude's). |
| `Stop` | done (reason `stop`). `reply` is the turn's `last_assistant_message`, carried inline on the payload so no transcript read is needed. |
| `PermissionRequest` | attention - Codex is blocked waiting for you to approve a command or tool call. |
| `SessionEnd` | ended - removes the row. |

- `session_key = codex:<session_id>`; title = the session's name when Codex has one, else the `cwd` folder name. A Codex `/rename` writes the thread name to `~/.codex/session_index.jsonl` (one JSON line per named session; last entry for the id wins) and the hook adopts it - toggleable via `codexRenameTitle` (Settings; default on), like Claude's. The user's own jumplist rename still overrides either.
- `codexClearEnds` mirrors `claudeClearEnds`: false keeps a `SessionEnd` with reason `clear` on the board as done. Inert unless Codex sends that reason.
- Host prefix (display only): a Codex session in an editor's integrated terminal shows under the editor's mark badged with Codex's glyph (`vscode/codex`), the same `TERM_PROGRAM` check as Claude; the key stays `codex:<id>`.
- `proc` and `SIGNALBOX_RAW` behave as for Claude (shell-wrapper walk to the agent process; raw-payload diagnostic).
- Codex also has a legacy `notify` program (fires `agent-turn-complete` as the final argv). The hooks path is preferred: it carries busy and attention too, not just turn-complete.

## VS Code - terminal jump-back - (available, still in testing)

No adapter and no config. Agents you run in VS Code's *integrated terminal* (claude, opencode, pi) already fire their own hooks; signalbox detects the editor terminal automatically (`TERM_PROGRAM=vscode`, set by VS Code on every terminal process) and captures an editor origin. Jump then raises the VS Code window for the project (`open -b com.microsoft.VSCode` plus a best-effort Accessibility `AXRaise` on the window whose title contains the workspace folder). **Window-level only** - VS Code's editor/terminal tabs are not externally addressable, the same limitation as Cursor.

- Cursor's integrated terminal is detected the same way (Cursor is a VS Code fork and also sets `TERM_PROGRAM=vscode`); the two are told apart by the process's `__CFBundleIdentifier`, defaulting to VS Code when it is absent. Other forks pass their own bundle id through.
- Icon: a detected editor host prefixes the agent's *display* name so the board shows the editor's mark badged with the agent glyph - `vscode/claude` (VS Code, and forks) or `cursor/claude` (Cursor). Display only: `session_key` keeps the agent family (`claude:<id>`), so a session stays on one row across a plain terminal and the editor. See the Claude adapter's host-prefix note above.
- A tmux pane inside the editor terminal still wins as the *jump* target (the pane is more precise), but the editor host still prefixes the display name.
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
`session_key = opencode:<sessionID>`; title from session info (cwd basename fallback); detail = last user prompt and reply = last assistant text part, both cached from the message events and passed through raw; the plugin cuts only at the shared caps and then passes `--cropped`.

## pi (extension, `components/cli/adapters/pi/signalbox.ts`)

Install:

```bash
signalbox init --agent pi
```


`agent_start` → busy · `agent_end` → done · `session_shutdown` → ended.
`session_key = pi:<session id>`; title = pi's session name (cwd basename fallback); detail = the last prompt, cached from the `input` event (`agent_start` carries no payload); reply from `agent_end`'s messages - both passed through raw; the extension cuts only at the shared caps and then passes `--cropped`, exactly like the OpenCode plugin. pi exposes no error or permission events, so a pi session shows only busy, done, or ended.

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
