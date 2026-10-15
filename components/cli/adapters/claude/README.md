# Claude Code adapter

Wires Claude Code hooks to `signalbox hook claude`, which reads the hook JSON
on stdin and maps it per [specs/adapters.md](../../../specs/adapters.md):

| Hook | Event |
|---|---|
| `SessionStart` | busy (reason `session_start`) |
| `SubagentStart` | busy on the explicit worker identity, linked to its owning session |
| `SubagentStop` | done on the worker identity, with its final transcript reply |
| `UserPromptSubmit` | busy + `prompt` = cropped prompt text |
| `Stop` | done (reason `stop`) |
| `Notification` (`permission_prompt` / `elicitation_dialog`) | attention |
| `Notification` (`idle_prompt`) | done (reason `idle`) |
| `PermissionRequest` | attention (reason `permission_request`) + `reply` = the actual ask, e.g. `Bash: git push` |
| `PreToolUse` (matcher `AskUserQuestion`) | attention (reason `question`) + `reply` = the question and its options |
| `StopFailure` | error (reason = `error_type`) |
| `SessionEnd` | hide (reason `session_end`), except `clear` |

## The exchange breadcrumb

Worker keys are `claude:<session_id>:agent:<agent_id>`. An owning-session link
does not claim which worker directly delegated the task. Workers have no
independent terminal origin; the jumplist labels a jump to the parent's terminal
explicitly. Launching another agent from a shell does not establish a session
relationship without an explicit identity link.

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
