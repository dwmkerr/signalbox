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
| **Cursor** | Cursor's own agent, via Cursor 1.7 Hooks (`~/.cursor/hooks.json`). | Available, still in testing |
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

The full event → state contract, and exactly what each adapter maps, is in
[specs/adapters.md](../components/specs/adapters.md) and [specs/events.md](../components/specs/events.md).

## Privacy

signalbox sends signals and a short breadcrumb of the exchange (your last prompt,
the agent's last message) - never full transcripts, and both are cropped at the
emitter. On machines where even that must not leave, `SIGNALBOX_PROFILE=redacted`
drops the cwd, title, prompt and reply and hashes the session id.
