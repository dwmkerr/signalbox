// tmux origin detection and the in-terminal signals - an exact port of the
// tmux-notify.sh behaviour (bell, pane bg, pane option, session suffix).

import { spawnSync } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import type { Origin } from "./event";

// Dark amber: visible against most themes without shouting.
const notifyBG = "bg=#1a0500";
const paneOption = "@claude_notify";
// Session-name suffix - visible in the session list (prefix-s).
export const bellSuffix = " 🔔";

// inside reports whether we are running in a tmux pane. Both variables are
// required, matching the guard in tmux-notify.sh.
export function inside(): boolean {
  return !!process.env.TMUX && !!process.env.TMUX_PANE;
}

// env is passed explicitly: Bun's spawnSync snapshots the environment at
// startup and ignores later process.env mutations, so without this the child
// tmux never sees a TMUX/TMUX_PANE set by a caller - which makes every pane
// behaviour here untestable.
function run(...args: string[]): string | null {
  const out = spawnSync("tmux", args, { env: process.env });
  if (out.status !== 0) return null;
  return (out.stdout?.toString() ?? "").trim();
}

// socketPath extracts the server socket from $TMUX ("socket,pid,index").
export function socketPath(): string {
  const env = process.env.TMUX ?? "";
  if (!env) return "";
  return env.split(",")[0] ?? "";
}

// Shells and editors are never the agent, so they lose a path tie-break.
const notAgentCommands = new Set(["bash", "sh", "zsh", "dash", "fish", "nvim", "vim", "less", "man"]);

// resolvePane returns the pane the AGENT is really in, which is not always the
// pane this process was launched from.
//
// Claude Code runs its hooks as children of the per-session agent, so
// TMUX_PANE is that session's pane and is correct. Codex does not: its hooks
// execute under a single long-lived `codex app-server` daemon, which inherits
// TMUX_PANE from wherever it first started. Every Codex session therefore
// reported the same pane, and jumping to any of them landed in whatever
// session happened to live there.
//
// The event's cwd is the discriminator. While TMUX_PANE's own path agrees with
// it the pane is this session's and is returned untouched, so agents that were
// already correct keep their pane - and with it the pane-derived session key.
// Once the two disagree the pane provably belongs to something else, and the
// agent is identified by the single pane sitting at that cwd. If none can be
// singled out, null: the one thing known for certain is that TMUX_PANE is
// wrong, and a confidently wrong jump is worse than no jump.
function resolvePane(pane: string, cwd: string, agent: string): string | null {
  if (!cwd) return pane;
  const here = run("display-message", "-p", "-t", pane, "#{pane_current_path}");
  if (here === null || here === cwd) return pane;
  const listed = run("list-panes", "-a", "-F", "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}");
  if (!listed) return pane;
  const atCwd = listed
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((p) => p.length === 3 && p[1] === cwd);
  // The agent's own name is the strongest signal, because a project directory
  // routinely holds several panes - a shell, an editor, a dev server - and only
  // one of them is the agent. Falling back to "not a shell or editor" is not
  // enough on its own: a running build tool would tie with the agent.
  const byAgent = agent ? atCwd.filter((p) => p[2] === agent) : [];
  // Narrowing must never empty the list: a pane at the right cwd running a
  // shell still beats no answer, so each filter is only applied while it leaves
  // something behind.
  const notShells = atCwd.filter((p) => !notAgentCommands.has(p[2]!));
  const candidates = byAgent.length > 0
    ? byAgent
    : notShells.length > 0
      ? notShells
      : atCwd;
  if (candidates.length === 1) return candidates[0]![0]!;
  // Several agents in one directory cannot be told apart: Codex exposes no link
  // from a session id to a pane - not in its process arguments, its environment,
  // or its open files - and its hooks run under a shared daemon, so the session
  // that fired this event is unknowable from here. The least-wrong answer is a
  // pane running the right agent in the right directory, which lands the user in
  // the right project even when it picks the wrong conversation. Sorted so
  // repeated events for one session keep choosing the same pane rather than
  // wandering between them.
  if (candidates.length > 1) {
    return candidates.map((p) => p[0]!).sort()[0]!;
  }
  // Nothing at that cwd at all: the pane is gone or the agent has moved on, and
  // TMUX_PANE is known wrong. Drop the origin so jump says it has nowhere to go.
  return null;
}

// currentOrigin resolves the calling pane into a jump target. Null outside
// tmux or when detection fails - an event without origin is still worth
// delivering. `cwd` is the agent's working directory, used to correct a pane
// that belongs to a shared daemon rather than to this session. `agent` is the
// agent family ("codex", "claude"), matched against the pane's running command.
export function currentOrigin(cwd = "", agent = ""): Origin | null {
  if (!inside()) return null;
  const pane = resolvePane(process.env.TMUX_PANE!, cwd, agent);
  if (pane === null) return null;
  const out = run("display-message", "-p", "-t", pane, "#{session_name}\t#{window_index}\t#{pane_id}");
  if (!out) return null;
  const parts = out.split("\t");
  if (parts.length !== 3) return null;
  const window = parseInt(parts[1], 10);
  if (Number.isNaN(window)) return null;
  const origin: Origin = {
    kind: "tmux",
    tmux: {
      // The bell suffix is our own artifact; jump matches exactly, so record
      // the stable base name.
      session: parts[0].endsWith(bellSuffix) ? parts[0].slice(0, -bellSuffix.length) : parts[0],
      window,
      pane: parts[2],
    },
  };
  const socket = socketPath();
  if (socket) origin.tmux!.socket = socket;
  // macOS propagates the launching app's bundle id into every child process;
  // capturing it is what lets jump raise the right terminal.
  const terminal = process.env.__CFBundleIdentifier;
  if (terminal) origin.tmux!.terminal = terminal;
  return origin;
}

// notify applies the three signals, each visible at a different distance:
// bell (window tab), pane background (within the window), session suffix
// (session list). Best-effort: partial failure leaves the other signals.
export function notify(): void {
  if (!inside()) return;
  const pane = process.env.TMUX_PANE!;

  const tty = run("display-message", "-p", "-t", pane, "#{pane_tty}");
  if (tty) {
    try {
      const fd = openSync(tty, "w");
      writeSync(fd, "\x07");
      closeSync(fd);
    } catch {
      // bell is best-effort
    }
  }

  run("set-option", "-p", "-t", pane, "window-style", notifyBG);
  // Avoid select-pane -P because it activates the agent pane.
  run("set-option", "-p", "-t", pane, paneOption, "1");

  const session = run("display-message", "-p", "#{session_name}");
  if (session !== null) {
    // Strip any existing suffix first so repeat notifies never stack bells.
    const base = session.endsWith(bellSuffix) ? session.slice(0, -bellSuffix.length) : session;
    run("rename-session", base + bellSuffix);
  }
}

// clear reverts everything notify set. All steps ignore errors, matching the
// script's clear action.
export function clear(): void {
  if (!inside()) return;
  const pane = process.env.TMUX_PANE!;
  run("set-option", "-pu", "-t", pane, "window-style");
  // Avoid select-pane -P because it activates the agent pane.
  run("set-option", "-pu", "-t", pane, paneOption);
  const session = run("display-message", "-p", "#{session_name}");
  if (session !== null && session.endsWith(bellSuffix)) {
    run("rename-session", session.slice(0, -bellSuffix.length));
  }
}
