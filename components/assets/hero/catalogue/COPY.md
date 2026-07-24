# Sharing copy (dwmkerr voice)

## Block 1

8 taglines. No tools needed — just craft in dwmkerr voice.

Let me write these directly.

1. Every AI coding agent, in one place, so you stop hunting for the one that stopped.
2. See which agent is working, which is done, and which is waiting on you.
3. Ctrl-Opt-J shows every agent session across your terminals and machines.
4. Your agents run everywhere. Their status lives in one menu bar.
5. Know which agent needs you without checking every terminal.
6. Live status for every coding agent, on your Mac and your phone.
7. Stop tab-hopping to find the agent that finished ten minutes ago.
8. One shortcut, every session, working or done or asking for you.

## Block 2

Show HN: Signalbox, a local jump box for AI coding agents

---

Maintainer's first comment:

I run a handful of coding agents at once and keep losing track of which one is actually waiting on me.

Signalbox watches your agent sessions locally and shows a live status line for each one, including the real question the agent is blocked on rather than just "running". When something needs you, hit Ctrl-Opt-J and it jumps you straight to that pane. Install is `brew install dwmkerr/tools/signalbox` then `signalbox init`.

The tradeoff is that it works out the status by reading what is on screen, so it is tuned to particular tools and layouts and will misread setups it has not seen. Honest limitation: it is local-first and terminal-based today, so if you walk away from the machine you are not getting notified anywhere else yet. The iOS app that would fix that is in testing, not public. Open question I have not solved well: how to reliably tell "the agent is waiting for input" apart from "the agent is thinking" without hard-coding a rule per tool. If you have a cleaner idea than screen-scraping, I would like to hear it.

---

Alternative titles:

Show HN: Signalbox, see which of your coding agents is waiting on you

Show HN: Signalbox, jump to the AI agent that needs you with one shortcut

## Block 3

(a) One-sentence definition for the top of the README:

Signalbox is a macOS menu bar app that gathers the status of every coding agent you have running, across Cursor, Claude Code, Codex, OpenCode and more, into one local hub so you can see which session needs you and jump to it with a keystroke.

(b) Sincere try-it / star-it line for near the top:

If you keep more than one agent going at once, it is a two minute install and it will save you some tab-hunting. If it earns its place, a star on the repo helps other people find it.

(c) Three subtitle / positioning lines for under the hero:

- One place to watch every coding agent you have running.
- Jump to the session that needs your input with a single keystroke.
- It runs locally in your menu bar, with no account and no telemetry.

## Block 4

Grounded in the repo's `docs/integrations.md` and `components/specs/adapters.md` (the per-agent hook mappings). One-liners below.

---

**Claude Code**
If you run Claude Code in a handful of terminals at once, signalbox puts every session on one board and jumps you to the one that needs you. It reads the full hook set, so you get the prompt and reply, the exact permission command it's blocked on, and the question it's asking with the options, not just a busy light.

**Codex**
signalbox watches your Codex sessions and shows which one is working, which is done, and the exact command it wants you to approve. Codex has no error hook yet, so a failed turn just goes quiet and ages off the board instead of showing red; that's an honest gap, not something I can fix from this side.

**Cursor**
signalbox tracks Cursor's own agent across every window on one board: working, done, errors, and the shell or MCP call it's waiting on. Jump raises the Cursor window for that workspace, but Cursor's tabs aren't addressable from outside, so it lands you on the window and not the specific Composer tab.

**OpenCode**
signalbox shows your OpenCode sessions on one board - working, done, errors, and permission prompts - and jumps you to the tmux pane that needs you. It's a small plugin and it's stable.

**pi**
signalbox shows your pi sessions on one board and lets you jump between them: busy, done, ended. pi exposes no error or permission hooks, so that's all there is to show, labelled honestly.

**General / dev**
If you're tab-hunting a pile of coding agents, signalbox reports them all to a local menu-bar hub and opens a jumplist on one keystroke, so you can see which session needs you and jump straight to it. Works with Claude Code, Codex, Cursor, OpenCode and pi; `brew install dwmkerr/tools/signalbox` then `signalbox init`, and everything stays on your machine.
