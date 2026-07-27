# Cursor IDE appearance (research partial + known facts)

The Cursor UI research subagent stalled (browser MCP hung) before writing its
full doc, but returned key colour findings. This file consolidates those with
established facts. Verify against a live Cursor before final polish.

## What Cursor is

The AI code editor by Anysphere (cursor.com) - a **fork of VS Code**, so the
chrome is VS Code's: title bar, a thin left activity bar (icon rail), file
explorer, the editor area, and a status bar. Cursor's addition is the **AI panel
on the right** (Chat / Composer / Agent) where the conversation happens.

## Layout (for the "open Cursor, send a message" beat)

- **Window**: dark, VS Code "Dark Modern"-style. Traffic-light dots top-left.
- **Left**: thin activity rail + a file tree (dim, secondary - keep it quiet).
- **Center**: the editor with a code file (a few syntax-coloured lines).
- **Right (the star)**: the AI chat/Composer pane. User message bubble at top,
  the assistant's streaming response below, and at the **bottom an input box**
  with a model selector (e.g. "claude-4.5-sonnet" / "gpt-5") and a submit arrow.
- **Working state**: the response streams in with a shimmer; a "Generating…"
  label and a stop button. Diffs render inline in the editor.

## Colours (hex)

- Editor / window background: VS Code Dark Modern - `#1f1f1f` editor, `#181818`
  side panels, `#252526` widgets (use these; they read as "Cursor" to anyone
  who's used it).
- **Diff / working accents (confirmed by research)**: added lines & progress
  green `#3FA266`; deleted / error pink-red `#E34671`. Use the green for the
  "done" success touch, the pink-red only if depicting a diff.
- Text: `#CCCCCC` primary, `#858585` dim.
- Cursor's brand mark is **monochrome** (black/white angular cube) - no loud
  brand colour; the IDE accent is restrained. Keep the window tasteful, not
  branded-loud.

## Logo

`logos/cursor-logo.svg` - the angular cube/cursor mark (simple-icons, CC0),
single-path, tint via `currentColor`. Monochrome by brand.

## Honest-casting note

In the demo Cursor is the **clean message beat**: open the IDE, type "refactor
the auth module to async/await", it works, returns a done reply. Cursor's
adapter does emit errors (status:error) - but we cast the error to OpenCode so
Cursor stays the positive opener. Cursor jump-back is **window-level** (raises
the Cursor window; cannot target a specific Composer tab) - keep the jump beat
truthful to that.

Sources: research subagent (partial, 2026-07-23) + VS Code Dark Modern theme
values. TODO if polishing: confirm the current AI-panel exact backgrounds and
the model-selector styling against a live Cursor.
