# signalbox demo — storyboard

A hand-composed HTML/SVG animation (same pipeline as
`docs/assets/hero-images/hero.html` — CSS keyframes on one master timeline,
stepped by Playwright via `Animation.currentTime`, captured to gif/mp4). Not a
screen recording: controlled, crisp, reproducible. Every beat must match what
the adapters actually do — `components/specs/adapters.md` is the fidelity check.

## Tone

Dry and understated. The product is not oversold — no exclamation marks, no
"from anywhere", no faked drama. A wry question, then the fix, then the install.

## The idea

You're running several agents at once, scattered across windows and tabs, and
you burn attention hunting between them. signalbox is one board (⌃⌥J) that shows
every session's live status so you jump straight to the one that needs you.

## Beats & timing (~16s loop)

| # | t (s) | Beat |
|---|---|---|
| 1 | 0.0–6.5 | **Tab-hunt.** Three agents running, overlapping: a **Cursor** window (clearly a GUI IDE — file tree, editor tabs, chat panel, green status bar) over a **terminal** with two tabs, **Claude** and **OpenCode**. The mouse hunts between them and clicks — the terminal tab even switches. Headline: **"Are you tab-hunting your agents?"** |
| 2 | 6.5–7.5 | **Shortcut.** The **⌃⌥J** keycap pops in the middle. |
| 3 | 7.0–13 | **Jump box.** The jumplist opens over the dimmed windows: every session with live status (one amber — blocked on a real question — two working). Up/down keycaps step the selection to the amber row. Subtext: **"See the status of all sessions in real time — jump to where you need to go."** |
| 4 | 13–15 | **Jump.** Enter; the session you need (the Claude terminal, the real AskUserQuestion dialog) raises to the front. |
| 5 | 15–16 | **End.** Mark + tagline ("One board for every agent, terminal, and job you run.") + `brew install dwmkerr/tools/signalbox`. Loops. |

## Honesty

The three agents are simply **running** — no faked message/ask/error staging.
One (Claude) is genuinely blocked on a question its `AskUserQuestion` tool
raised, shown as the real board reply and the real terminal dialog — that's the
one you jump to, which motivates the whole flow. Nothing is depicted that an
adapter doesn't do. Cursor and OpenCode are shown working, not erroring (and
Codex isn't used here — it has no error hook and needs no cameo).

## Direction notes

- Cursor MUST read as a GUI IDE, not a terminal: the explorer, editor tabs,
  syntax colours, chat panel, and the green status bar are what sell it.
- Scene animations are **opacity-only**; any transform (keycap pop, window
  raise, caption rise) lives on the child so a full-bleed scene shift never
  doubles a centered child's transform.
- The board reveal keeps the windows faintly behind (depth), then the jump
  raises one to full.

## Files

- `demo.html` — the animation (self-contained inline CSS/SVG).
- `capture.js` — renders to frames → mp4/gif (see its header).
- `references/` — per-agent visual specs (signalbox chrome, Claude/Codex/Cursor)
  and vendor logo SVGs with sources.

## Earlier cut

A first version staged three *outcomes* (done / question / error) across the
agents with a phone-closer. It was too long and too salesy; this cut replaces
it. The outcome-casting analysis (which agent can honestly show what) still
lives in the adapters capability matrix if a future asset wants it.
