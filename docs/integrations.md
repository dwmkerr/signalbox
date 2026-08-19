# Integrations

signalbox wires your coding agents to report progress to the local hub. Set them
up with `signalbox init` (interactive) or one at a time with
`signalbox init --agent <name>`; remove with `signalbox init --remove --agent <name>`.

`init` wires JSON agent configs (`~/.claude/settings.json`,
`~/.cursor/hooks.json`) for you, with consent: it takes a timestamped backup,
merges only events that have no hooks at all (your own wrappers are never
touched), and writes atomically. `--remove` reverses exactly that edit.
Freeform config like `~/.tmux.conf` gets its exact snippet printed for you to
apply; add `--write-user-config` to have `init` write it as a fenced managed
block (backup taken, `--reverse` removes only signalbox's own lines).

| Agent | How it's wired | Status |
|---|---|---|
| **Claude Code** | Hooks in `~/.claude/settings.json` that fire as Claude works. | Stable |
| **Cursor** | Cursor's own agent, via Cursor 1.7 Hooks (`~/.cursor/hooks.json`). | Available |
| **Codex** | Hooks in `~/.codex/hooks.json` (needs `[features] hooks = true`) that fire as Codex works, asks and needs approval. | Available, still in testing |
| **VS Code** | Agents in the integrated terminal are auto-detected (`TERM_PROGRAM`); jump raises the VS Code window (window-level, not tab). No setup. | Available, still in testing |
| **OpenCode** | A plugin in `~/.config/opencode/plugin`. | Stable |
| **pi** | An extension in `~/.pi/agent/extensions`. | Stable |

## Anything else

Not a supported agent? Any script, cron job or CI run can post to the board with
`signalbox fire`:

```bash
signalbox fire --agent github --event done \
  --title "deploy" \
  --reply "Workflow run #9182 succeeded in 4m 12s." \
  --origin-url "https://github.com/dwmkerr/signalbox/actions/runs/9182"
```

The complete event-to-state contract and adapter mappings are in
[specs/events.md](../components/specs/events.md) and
[specs/adapters.md](../components/specs/adapters.md). The
[Agent Markdown specification](../components/specs/agent-markdown.md) defines
the shared grammar, one-line preview rule, and crop marker.

## Privacy

Signalbox preserves raw multiline Markdown in prompts and replies and sends it
to the configured hub. Emitters cap prompts at 1,024 characters and replies at
10,240 characters. An event with `cropped: true` reports that one of those
values was cut. The configured hub keeps a bounded per-session ring of
exchanges.

A local hub retains this data on the local machine. A remote configuration
sends it to the remote host. Set `SIGNALBOX_PROFILE=redacted` when session
content must not leave a machine. The redacted profile removes `cwd`, `title`,
`prompt`, `reply`, `cropped`, and `raw`, and hashes `session_key`.
