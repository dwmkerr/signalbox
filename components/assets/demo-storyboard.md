# signalbox hero

The launch visual. Direction: **the product is the pitch** - the jump box is
what signalbox is, so the hero is the jump box. No desktop, no windows, no
multi-scene story (earlier cuts tried that; they read as over-produced).

`demo.html`: press **Ctrl-Opt-J**, the board scales in with every session's
live status, and it holds. A ~4.5s loop (or grab a single frame for a still).

The board shows the range on purpose: four different agents (Claude, OpenCode,
Codex, Cursor), one **asking** (amber, with its real question, resting under the
selection - the one you jump to), one **done** (blue), two **working**
(spinners). Footer carries the shortcut; tagline + `brew install` under it.

Honest: every row is something an adapter actually produces (see the capability
matrix in `components/specs/adapters.md`). Same palette/glyphs as the real
jumplist (`components/specs/hub-jumplist.html`).

Render: `node components/assets/capture.js` then the ffmpeg lines in its header
(DURATION is 4500ms). `references/` holds the per-agent visual specs + logos.
