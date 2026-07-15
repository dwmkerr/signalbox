# signalbox

A local-first events board for AI coding agents. One board for every agent,
terminal, and job you run.

## Specs are the source of truth - keep them current

**Whenever you change behaviour, update the spec in the same change.** The specs
in `components/specs/` describe the contract; they must never lag the code.

- `components/specs/cli.md` - every CLI command, flag, and its output. Update it
  when you add/rename/remove a command or flag, or change what a command prints.
- `components/specs/events.md` - the wire schema (event types, fields, reducer
  rules). Update it when the event shape or reducer behaviour changes.
- `components/specs/adapters.md` - how each agent adapter fires events.
- **`components/specs/*.html` are the living spec for the app's UI surfaces** -
  the HTML mock IS the source of truth for that surface, not just an
  illustration:
  - `components/specs/settings.html` - the Settings window (every control, its
    label, caption, and the settings-storage table). Change a setting -> update
    this.
  - `components/specs/hub-jumplist.html` - the jumplist (rows, keys, footer,
    marks).
  - `components/specs/menubar.html` - the menu bar icon + dropdown.
  When you add/change/remove a control or behaviour on one of these surfaces,
  update its HTML mock in the same change.

If a change touches behaviour and you did not touch a spec, that is a bug in the
change. Treat "code and spec disagree" as a failing state.

## Layout

- `components/cli/` - the TypeScript CLI + hub, compiled to a single binary with
  Bun (`bun build --compile`). The hub is `signalbox hub` (same binary).
- `components/app/` - the Swift macOS menu bar app (jumplist, status icon,
  settings). The app OWNS the hub: it spawns `signalbox hub` as a child,
  keeps it alive, and stops it on quit (Hub.swift) - there is no LaunchAgent.
  The bundle embeds the CLI at Contents/Resources/signalbox. Built via
  `components/app/Makefile` (it works around a CommandLineTools SPM manifest
  bug - use `make -C components/app build`, not bare `swift build`).
- `components/cli/adapters/` - per-agent hooks/plugins (claude, opencode, pi) and
  tmux.
- `components/scripts/` - dev helpers (e.g. `demo.sh` seeds a board via `fire`).
- `packaging/` - the Homebrew formula template.
- `docs/`, `components/specs/` - docs site and specs.

## Build & test

```bash
make build                     # compile the CLI to components/cli/bin/signalbox
make -C components/app build   # build the menu bar app
cd components/cli && bun test  # CLI + reducer tests
cd components/cli && bunx tsc --noEmit   # typecheck
```

`~/.local/bin/signalbox` is symlinked to `components/cli/bin/signalbox`, so
`make build` deploys the CLI. The app supervises the hub: `make install` kills
a running hub and the app respawns it with the new build within seconds;
relaunch the app itself to pick up an app rebuild.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, ...).
- Comments explain *why*, not *what* - no breadcrumb comments.
- Use a regular hyphen (-), never an em-dash, anywhere in code, comments, or docs.
- Only ever write files signalbox owns (its adapter symlinks). User config
  (Claude settings, tmux.conf) gets a printed snippet, never an edit - the
  same rule governs install and removal.
