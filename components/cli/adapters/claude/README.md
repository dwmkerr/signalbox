# Claude Code adapter

Wires Claude Code hooks to `signalbox hook claude`, which reads the hook JSON
on stdin and maps it per [specs/adapters.md](../../../specs/adapters.md):

| Hook | Event |
|---|---|
| `SessionStart` | busy (reason `session_start`) |
| `UserPromptSubmit` | busy + `prompt` = cropped prompt text |
| `Stop` | done (reason `stop`) |
| `Notification` (`permission_prompt` / `elicitation_dialog`) | attention |
| `Notification` (`idle_prompt`) | done (reason `idle`) |
| `StopFailure` | error (reason = `error_type`) |
| `SessionEnd` | ended |

## The exchange breadcrumb

The hook extracts the prompt text from the `UserPromptSubmit` payload and
sends it as `prompt` - a single line cropped to 160 chars at the emitter,
never a transcript. Surfaces (the jumplist, the menu bar) render it as a dim
second line so you can tell sessions apart at a glance. Later events for the
session (`Stop` carries no prompt text) keep the last value: the hub merges,
latest non-empty wins.

On shared or corporate hosts set `SIGNALBOX_PROFILE=redacted`: `cwd`, `title`
and the breadcrumb are omitted and the session id is hashed, so only the
signal itself leaves the machine.

## Install

`signalbox init --agent claude` merges the `hooks` block into
`~/.claude/settings.json` for you (timestamped backup, atomic write; the
same block lives in [hooks-settings.json](hooks-settings.json) to apply by
hand). `signalbox` must be on `PATH` (or use the absolute path to the binary
in each `command`).
