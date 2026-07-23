# Claude Code CLI appearance (captured this session, v2.1.218)

Real reference from shellwright captures on 2026-07-23. This is exactly what the
terminal shows - reproduce faithfully.

## Welcome box (session start)

A rounded box-drawing frame (`╭─── Claude Code v2.1.218 ───...╮`), split into
two columns:
- Left: centered "Welcome back Dave!", a small pixel-art Claude mark
  (`▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝`), then dim lines: "Opus 4.8 (1M context) with
  hi... · Claude Max ·", "dwmkerr@gmail.com's Organization", the cwd
  "~/.../signalbox/main/scratch/xscript-test".
- Right: "Tips for getting started", a divider, "What's new" with dim bullet
  lines, "/release-notes for more".
- Below the box: a warning line "⚠ 1 MCP server needs authentication · run /mcp".

## Prompt line

`❯ <your prompt text>` on its own line under a horizontal rule.
Placeholder hints rotate: `Try "refactor <filepath>"`, `Try "how does
setup.test.ts work?"`.

## Working / spinner

A single animated line: a spinner glyph (`✻ ✽ ✶ ✳ ✢ · ✽`) + a whimsical gerund +
elapsed + token count, e.g. `✽ Leavening... (3s · ↓ 138 tokens)`,
`✻ Cogitated for 8s`, `Boondoggling...`, `Julienning...`, `Meandering...`,
`Churned for 1m 27s`, "thinking with high effort".

## Tool call marker

`⏺ Bash(rm test-file.txt)` then an indented `⎿  Waiting...` while it runs;
resolves to `⎿  <result>` or `⎿  Interrupted · What should Claude do instead?`.

## Permission dialog (the "ask" beat)

Under a rule:
```
 Bash command

   rm test-file.txt
   Delete test-file.txt

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for: open *
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```
The selected option has a `❯` caret. Header names the tool ("Bash command").

## AskUserQuestion dialog (the differentiator - the "question" beat)

```
 ☐ City

Which city do you prefer?

❯ 1. Paris
     Prefer Paris
  2. Tokyo
     Prefer Tokyo
  3. Type something.
────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
```
- `☐ <Header>` (the short header, e.g. "City", "Animal", "Terrain").
- The question, then numbered options each with a dim description line under it.
- Always a "Type something." and "Chat about this" tail option.
- Footer: `Enter to select · ↑/↓ to navigate · Esc to cancel`.
- On answer: `⏺ User answered Claude's questions:` / `⎿ · <question> → <choice>`.
- On decline (Esc): `⏺ User declined to answer questions` / `⎿ · <question> (opt / opt)`.

## Status line (bottom)

`⏸ manual mode on · ← for agents` and
`dwmkerr <cwd> <branch> | NN% context | Opus 4.8 (1M context) high (/model) ? for help`
plus `● high · /effort`.

## Colors (approximate, dark terminal)

- Claude mark / accents: Anthropic clay/coral `#D97757`.
- Prompt `❯`, selected caret: bright.
- Dim hints/descriptions: grey.
- Box-drawing frame: mid-grey.
- Terminal bg: near-black (the captures used a warm-dark scheme; a neutral
  `#0d0d0f`-ish reads fine).

Source: shellwright sessions in this conversation (2026-07-23), plus Dave's
screenshots. Cross-check the exact Anthropic brand mark in logos/.
