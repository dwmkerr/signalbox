# signalbox visual language (ground truth)

The demo's own chrome. Canonical source: `components/specs/hub-jumplist.html`
(the living spec for the jumplist) and `Palette.swift`. Do NOT invent - match
these exactly so the demo reads as the real app.

## The jumplist panel

- Dark floating panel, heavy rounded corners, big drop shadow
  (`box-shadow:0 18px 50px rgba(0,0,0,.6)`), `user-select:none`.
- Header row: the signalbox mark + wordmark "signalbox" on the left, a
  "Search sessions..." placeholder input filling the middle, "Jump ⏎" affordance
  top-right.
- Left column: `SESSIONS` label (letter-spaced, dim), then the rows.
- Right column (split view): preview pane for the selected row - the prompt at
  top, the reply/ask below, a "Jump to iTerm (tmux ...)" location line.
- Footer keybar: `type to search · ^j/^k move · ^1-9 direct · tab next unread ·
  ^p pin · ^r rename · ^x hide · ^⌫ remove · ⏎ jump · esc clear/close`.

## Row anatomy (left to right)

1. Status dot (10px): amber `#FF9F0A` = asking, blue `#0A84FF` (unread) =
   finished/needs-look, open ring = read/working (spinner ring animates).
2. Agent glyph (see below).
3. Title (bold when unread) + a dim one-line breadcrumb under it (prompt while
   working, reply/ask once finished or asking).
4. Right edge: a quiet pin (age tier `#98989D`, only when pinned) then the age
   ("6s", "1m", "23m").

## Palette (hex)

- Panel text bright: `#ADADB2` · dim breadcrumb/footer: `#6E6E73` · age tier: `#98989D`
- Amber (ask): `#FF9F0A` / `#FF9500` · blue (unread/finished): `#0A84FF`
- Working spinner arc: `#98989D` on a `rgba(152,152,157,.25)` track
- Background: near-black panel (~`#1c1c1e`/`#232326` gradient), rows hover ~`#2a2a2c`

## Agent glyphs (canonical, from hub-jumplist.html AG map)

- **claude**: 8-spoke asterisk/sunburst, `#D97757` (Anthropic clay/coral),
  stroke 2.1, round caps. Built as 8 lines from center (r=8).
- **codex**: hollow hexagon, `#10A37F` (OpenAI green), stroke 1.7, viewBox 20.
  Path `M18 10 L14 16.93 L6 16.93 L2 10 L6 3.07 L14 3.07 Z`.
- **opencode**: rounded-rect terminal with a green `>` chevron `#32D74B` + grey frame `#B5B5BA`.
- **pi**: monospace `π` glyph in `#0A84FF`.
- **github**: octocat mark in grey `#B5B5BA`.
- **cursor**: (not in the AG map yet - see cursor-ui.md; needs a glyph.)

These are signalbox's OWN stylized marks for the board, deliberately monochrome-
ish and line-weight consistent, NOT the vendors' full-color logos. The board
scenes use THESE. The "agent window" scenes (a real Cursor/Claude/Codex window)
use the vendors' real chrome - see the per-agent references.

## Status semantics (for honest casting)

- working = open spinning ring, breadcrumb shows the prompt.
- asking (amber) = `permission_request` shows the command (`Bash: git push`),
  `question` shows the question + options (`Which auth? (JWT / sessions)`).
- finished (blue/unread) = reply breadcrumb.
- error (red) = only claude / cursor / opencode / github can reach this;
  **codex has no error hook** (see components/specs/adapters.md matrix).
