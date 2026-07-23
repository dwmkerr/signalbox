# signalbox demo — storyboard

The launch hero: a hand-composed HTML/SVG animation (same pipeline as
`docs/assets/hero-images/hero.html` — CSS keyframes stepped by Playwright via
`Animation.currentTime`, captured to gif/mp4). Not a screen recording:
controlled, crisp, reproducible, zoomable. But **every beat must match what the
real adapter actually does** — the capability matrix in
`components/specs/adapters.md` is the fidelity checklist. A technical audience
will spot a fake; a fake in front of that audience is worse than no video.

## The one-line promise

> You run more agents than you can watch. signalbox is the board that tells you
> which one needs you — and shows the actual question, so you can answer from
> anywhere.

## Casting (forced by honesty)

The three outcomes Dave wants — **one message, one ask, one error** — cross the
capability matrix like this:

- **error** can only be Claude / Cursor / OpenCode / GitHub. **Codex has no
  error hook** — depicting Codex erroring is the one thing that reads as fake.
- **question-with-options** (the differentiator) is Claude's `AskUserQuestion`
  only — no other agent has the tool.

So the trio can't be {Cursor, Claude, Codex} + {message, options-question,
error} at once. Two honest cuts:

### Primary cut (3 agents) — RECOMMENDED, keeps the differentiator
| Beat | Agent | Outcome | On-board reply (the real ask) |
|---|---|---|---|
| 1 message | **Cursor** | done + reply | "Refactored 4 auth handlers — tests green." |
| 2 ask | **Claude Code** | question (options) | "Overwrite writing-style.yml? (Overwrite / Keep mine)" |
| 3 error | **OpenCode** | error | "session.error: ENOSPC — no space left on device" |

Cursor is the clean, positive opener (Dave's "open Cursor, send a message").
Claude carries the wow (the options-question — the reason signalbox is special).
OpenCode carries the honest error (it has a `session.error` hook). Bonus: three
different agents = the "one board for every agent" story.

### Extended cut (4 agents) — adds Codex, marquee-complete
Insert between beats 1 and 2:
| 1.5 ask | **Codex** | permission | "Allow: `npm publish --access public`?" |
Codex's real permission ask shows the command. Four staggered callbacks tell the
breadth story hardest, at the cost of ~4s more runtime. Build supports both;
trimming Codex is deleting one lane.

> Swap note: if Codex must appear in a 3-agent cut, use Cursor=message,
> Codex=permission-ask, Claude=error — but that drops the options-question,
> which is the single best reason to care. Don't, unless runtime forces it.

## Beats & timing (primary cut, ~28s loop)

Times are cumulative seconds on the master timeline.

**0.0–3.0 — Hook.** Black. Type-on caption: *"You run more agents than you can
watch."* The three agent windows sit dim/tiled behind it, faintly alive.

**3.0–8.0 — Fire three.** Camera settles on the tiled windows. In quick
succession, a prompt lands in each and each starts working:
- Cursor (IDE, right-side Composer): user line "refactor the auth module to
  async/await", the working shimmer starts.
- Claude (terminal): `❯ tidy up my writing-style config` → spinner
  `✽ Leavening… (2s)`.
- OpenCode (terminal): a prompt → working.
Each window shows its REAL working state (see per-agent references).

**8.0–10.0 — The problem.** Windows keep working; caption: *"Now… which one
needs you?"* Beat of tension — you can't watch all three.

**10.0–12.0 — The board opens.** The jumplist slides in (⌃⌥J). Three rows,
each with its agent glyph, all showing the working ring + their prompt
breadcrumb. This is the "one board" reveal.

**12.0–19.0 — Staggered callbacks (the core).** One at a time, ~2s apart, each
row resolves — dot flips, breadcrumb becomes the real reply/ask. **Zoom into
each row as it flips**, caption naming what just happened:
- Cursor row → blue dot, "Refactored 4 auth handlers — tests green." Caption:
  *"Done."*
- Claude row → amber dot, "Overwrite writing-style.yml? (Overwrite / Keep mine)".
  Caption: *"Claude's asking — and you can see the actual question."* (HOLD here,
  biggest zoom — this is the differentiator.)
- OpenCode row → red dot, "session.error: ENOSPC — no space left on device".
  Caption: *"OpenCode failed — you'd never have noticed."*

**19.0–24.0 — Jump.** Select the Claude (amber) row; `⏎`. The board dismisses,
the Claude terminal raises to front with the question dialog live. Caption:
*"One key — jump straight to the one that needs you."* (Optionally a quick
second jump to the OpenCode error.)

**24.0–27.0 — From anywhere (phone).** Same board on the iOS app in a phone
frame; the amber Claude row and its question are right there. Caption: *"Your
agents. From anywhere."* (Honest: the phone SHOWS the ask and lets you jump on
your Mac — it does NOT answer for you. Do not depict remote answering.)

**27.0–28.0 — End card.** signalbox mark + wordmark, the promise line, and the
install line `brew install dwmkerr/tap/signalbox` (verify the real tap in
packaging/). Loops back to black.

## Direction notes

- **Zoom** = CSS `transform: scale()` + translate on a camera layer, eased.
  Zoom into a row uses the row's center as transform-origin.
- **Captions**: bottom-third, generous type, fade+rise in, hold, fade out.
  One idea per caption. Never cover the thing being shown.
- **Timing is the product**: the staggered callback (12–19s) is the whole
  emotional payload — resist rushing it. Each flip needs a breath.
- **Palette**: signalbox chrome from signalbox-visual-language.md; agent windows
  from their per-agent references. Board glyphs = signalbox's own marks; agent
  windows = vendors' real chrome.
- **Honesty checklist** (must all hold): Cursor message is a clean done; Claude
  ask is a real AskUserQuestion with real-looking options; OpenCode error is a
  real `session.error`; no Codex error anywhere; the phone never answers.

## Files

- `components/assets/demo.html` — the animation (self-contained, inline CSS/SVG/JS).
- `components/assets/references/` — per-agent visual specs + logos + sources.
- `components/assets/capture.js` — Playwright frame-stepper (mirrors the hero-gif
  script in the repo CLAUDE.md), if we render to gif/mp4.
