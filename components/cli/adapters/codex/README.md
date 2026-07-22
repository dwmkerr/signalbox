# Codex adapter

Wires OpenAI Codex CLI hooks to `signalbox hook codex`, which reads the hook
JSON on stdin and maps it per [specs/adapters.md](../../../specs/adapters.md):

| Hook | Event |
|---|---|
| `SessionStart` | busy (reason `session_start`) |
| `UserPromptSubmit` | busy + `prompt` = cropped prompt text |
| `Stop` | done (reason `stop`), `reply` = `last_assistant_message` |
| `PermissionRequest` | attention (blocked on approval) |
| `SessionEnd` | ended |

`session_key = codex:<session_id>`; the title is the `cwd` folder name.

## Setup

Codex hooks need `[features] hooks = true` in `~/.codex/config.toml`. Then run:

```bash
signalbox init --agent codex
```

It prints a `~/.codex/hooks.json` block to merge by hand - signalbox never edits
your config. The block sits alongside any hooks you already have (Codex fires
them all), and Codex records a trust hash for the new hook on its next run.

## Notes

- The Stop payload carries `last_assistant_message` inline, so reply capture
  needs no transcript read (unlike the Claude adapter).
- Codex also exposes a legacy `notify` program (fires `agent-turn-complete` as
  the final argv). The hooks path is preferred because it also carries busy and
  attention, not just turn-complete.
