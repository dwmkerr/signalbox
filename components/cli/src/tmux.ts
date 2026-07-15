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

function run(...args: string[]): string | null {
  const out = spawnSync("tmux", args);
  if (out.status !== 0) return null;
  return (out.stdout?.toString() ?? "").trim();
}

// socketPath extracts the server socket from $TMUX ("socket,pid,index").
export function socketPath(): string {
  const env = process.env.TMUX ?? "";
  if (!env) return "";
  return env.split(",")[0] ?? "";
}

// currentOrigin resolves the calling pane into a jump target. Null outside
// tmux or when detection fails - an event without origin is still worth
// delivering.
export function currentOrigin(): Origin | null {
  if (!inside()) return null;
  const pane = process.env.TMUX_PANE!;
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

  run("select-pane", "-t", pane, "-P", notifyBG);
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
  run("select-pane", "-t", pane, "-P", "default");
  run("set-option", "-pu", "-t", pane, paneOption);
  const session = run("display-message", "-p", "#{session_name}");
  if (session !== null && session.endsWith(bellSuffix)) {
    run("rename-session", session.slice(0, -bellSuffix.length));
  }
}
