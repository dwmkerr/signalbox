# components/assets

Launch/marketing assets, hand-composed so they're crisp, reproducible, and
publishable with the site (no external image dependencies).

## The demo animation

- **`demo.html`** — the 28s launch hero: three agents fire, the board lights up,
  each resolves (done / the real question / an error), jump to the one that
  needs you, then the phone. Self-contained HTML/CSS/SVG on one master timeline.
- **`demo-storyboard.md`** — the storyboard: beats, timing, and the
  **honest-casting** rationale (Cursor=message, Claude=question-with-options,
  OpenCode=error — Codex is never the error row because it has no error hook).
- **`capture.js`** — renders `demo.html` to frames → mp4/gif (see its header).
- **`references/`** — the visual specs each scene is built from: signalbox's own
  chrome, per-agent UI (Claude/Codex/Cursor), and vendor logo SVGs with sources.

Preview: open `demo.html` in a browser (it loops). To render:
`node components/assets/capture.js` then the ffmpeg lines in `capture.js`.

## Fidelity rule

Every beat must match what the real adapter does — the capability matrix in
`components/specs/adapters.md` is the checklist. A fake in front of a technical
audience is worse than no video.
