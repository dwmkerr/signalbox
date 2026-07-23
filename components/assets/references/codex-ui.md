# Codex CLI appearance (from Dave's screenshot, codex-cli 0.145.0)

Real reference from a screenshot this session (2026-07-23). A subagent should
verify/deepen colours and layout against current Codex docs/screenshots.

## Prompt / input

`> can u check my downloads` - a `>` prompt, plain text. Non-interactive turns
via `codex exec`.

## Model / directory banner

A small dim block:
```
 model:      gpt-5.6-sol xhigh   /model to change
 directory:  ~/repos/github/dwmkerr/signalbox
```

## Permission dialog (the "ask" beat, if Codex is cast for it)

```
 This command requires approval

 Do you want to proceed?
 › 1. Yes

 Esc to cancel · Tab to amend · ctrl+e to explain
```
Codex uses a `›` caret (vs Claude's `❯`). Fuller form seen elsewhere:
`1. Yes  2. Yes, and don't ask again for: open *  3. No`.

## Tips / chrome

- `Tip: [New] Build faster with the Desktop app. Run 'codex app' or visit
  https://chatgpt.com/codex?app-landing-page=true`
- Session rename line: `• Session renamed to permtest-codex. To resume this
  session run codex resume, then select permtest-codex (019f8e61-...)`.

## Error line (IMPORTANT for honest casting)

`• Missing environment variable: AI_GATEWAY_API_KEY` rendered in RED with a
red `•` bullet. BUT: this error prints in the terminal and Codex fires NO error
hook - so signalbox does NOT show it as an error. **Do not depict Codex as an
error row on the board.** Codex's board-eligible states: working, done (reply),
permission ask. (See components/specs/adapters.md capability matrix.)

## Colours

- ChatGPT/OpenAI green `#10A37F` is signalbox's codex glyph colour; verify
  Codex's own CLI accent (may be near-white/monochrome with green touches).
- Errors: red `•` + red text.
- Model/dir banner: dim grey.

## Logo

Codex/OpenAI mark needed in logos/ (the OpenAI "blossom" or the Codex wordmark).
signalbox's board glyph is a hollow green hexagon (its own stylization, not the
official mark).

Source: Dave's screenshot #14 this session. Verify current appearance with a
subagent (codex 0.145.0).
