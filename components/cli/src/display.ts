// Terminal rendering: status glyphs in the amber scheme, the state table,
// the tmux status segment, and the interactive picker. Per specs/cli.md.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import * as ev from "./event";
import type { Event } from "./event";

// dim brackets ANSI faint text - how acked rows and detail de-emphasize.
export const dimOn = "\x1b[2m";
export const dimOff = "\x1b[0m";

// statusWord maps event types to the contract's self-documenting words.
export function statusWord(eventType: string): string {
  switch (eventType) {
    case ev.Attention:
      return "needs you";
    case ev.Error:
      return "error";
    case ev.Done:
      return "ready";
    case ev.Busy:
      return "working";
  }
  return eventType;
}

// glyph maps a row to the contract's status mark: ◌ working, ● waiting
// (the color carries asking vs unread), ✕ failed, · read. No "?" suffix -
// amber already means asking. Acked rows read as "read" whatever their
// status; busy keeps its spinner because the session is still running.
export function glyph(s: Event): string {
  if (s.acked && s.event !== ev.Busy) return "·";
  switch (s.event) {
    case ev.Busy:
      return "◌";
    case ev.Done:
    case ev.Attention:
      return "●";
    case ev.Error:
      return "✕";
  }
  return "·";
}

// coloredGlyph wraps the mark in its temperature: amber = needs your input
// (act), blue = output updated (look), red = failed (fix), dim = working and
// read. ANSI 256-color 214 for amber - plain yellow reads green-ish.
export function coloredGlyph(s: Event): string {
  const g = glyph(s);
  if (s.acked && s.event !== ev.Busy) return dimOn + g + dimOff;
  switch (s.event) {
    case ev.Attention:
      return `\x1b[38;5;214m${g}\x1b[0m`;
    case ev.Done:
      return `\x1b[34m${g}\x1b[0m`;
    case ev.Error:
      return `\x1b[31m${g}\x1b[0m`;
  }
  return dimOn + g + dimOff;
}

// titleOf resolves the displayed name: the user's own label beats the agent
// title beats the cwd basename.
export function titleOf(e: Event): string {
  if (e.label) return e.label;
  if (e.title) return e.title;
  if (e.cwd) return basename(e.cwd);
  return "-";
}

export function age(ts: string, now: number = Date.now()): string {
  const seconds = Math.floor((now - Date.parse(ts)) / 1000);
  if (seconds < 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// needsYou: unacked, unhidden attention/error/done - the rows a badge counts.
export function needsYou(e: Event): boolean {
  if (e.acked || e.hidden) return false;
  return e.event === ev.Attention || e.event === ev.Error || e.event === ev.Done;
}

// visible filters to the rows every surface shows: only hidden rows drop out
// (seen clears the flag, never the row).
export function visible(sessions: Event[]): Event[] {
  return sessions.filter((s) => !s.hidden);
}

// tmuxStatusLine renders the status-right segment in the unified
// temperatures: amber ● asking (act) · blue ● unread (look) · red ✕ failed
// (fix); empty when nothing waits. tmux #[] style ranges, not raw ANSI.
// colour214 because tmux's named "yellow" is too green to read as amber.
export function tmuxStatusLine(sessions: Event[]): string {
  let asking = 0;
  let unread = 0;
  let failed = 0;
  for (const s of sessions) {
    if (s.acked || s.hidden) continue;
    if (s.event === ev.Attention) asking++;
    else if (s.event === ev.Done) unread++;
    else if (s.event === ev.Error) failed++;
  }
  const parts: string[] = [];
  if (asking > 0) parts.push(`#[fg=colour214]● ${asking}#[default]`);
  if (unread > 0) parts.push(`#[fg=blue]● ${unread}#[default]`);
  if (failed > 0) parts.push(`#[fg=red]✕ ${failed}#[default]`);
  return parts.join(" ");
}

// visibleWidth counts display cells, skipping ANSI CSI sequences - padding
// computed on raw code points would drift on colored cells.
export function visibleWidth(s: string): number {
  let n = 0;
  let inEsc = false;
  for (const ch of s) {
    if (inEsc) {
      if (/[a-zA-Z]/.test(ch)) inEsc = false;
    } else if (ch === "\x1b") {
      inEsc = true;
    } else {
      n++;
    }
  }
  return n;
}

// cropRunes hard-crops for display, marking the cut so a crop is never
// mistaken for the full text.
export function cropRunes(s: string, max: number): string {
  if (max <= 0) return "";
  const points = Array.from(s);
  if (points.length <= max) return s;
  if (max === 1) return "…";
  return points.slice(0, max - 1).join("") + "…";
}

// termWidth prefers $COLUMNS, then stty; 120 keeps piped output readable.
export function termWidth(): number {
  const cols = parseInt(process.env.COLUMNS ?? "", 10);
  if (cols > 0) return cols;
  const out = spawnSync("stty", ["size"], { stdio: ["inherit", "pipe", "ignore"] });
  if (out.status === 0) {
    const fields = out.stdout.toString().trim().split(/\s+/);
    if (fields.length === 2) {
      const n = parseInt(fields[1], 10);
      if (n > 0) return n;
    }
  }
  return 120;
}

// printSessions renders self-documenting rows: status words instead of a
// legend, acked rows dimmed (or textually marked when piped), detail in the
// last column cropped so lines never wrap.
export function printSessions(sessions: Event[], tty: boolean): string {
  const header = ["STATUS", "AGENT", "TITLE", "KEY", "AGE", "PROMPT"];
  const rows = sessions.map((s) => {
    let g = glyph(s);
    // Acked/hidden rows stay uncolored: the whole line dims, and a color
    // reset inside the glyph would cancel the dim for the rest of the line.
    if (tty && !s.acked && !s.hidden) g = coloredGlyph(s);
    let status = `${g} ${statusWord(s.event)}`;
    if (!tty) {
      if (s.hidden) status += " (hidden)";
      else if (s.acked) status += " (seen)";
    }
    return [status, s.agent, titleOf(s), s.session_key, age(s.ts), s.prompt ?? ""];
  });

  const last = header.length - 1;
  const widths = header.slice(0, last).map((h) => visibleWidth(h));
  for (const r of rows) {
    for (let i = 0; i < widths.length; i++) {
      const n = visibleWidth(r[i]);
      if (n > widths[i]) widths[i] = n;
    }
  }
  let detailBudget = termWidth() - 2;
  for (const w of widths) detailBudget -= w + 2;

  const lines: string[] = [];
  const printRow = (cells: string[], dim: boolean) => {
    let b = "";
    for (let i = 0; i < widths.length; i++) {
      b += cells[i] + " ".repeat(widths[i] - visibleWidth(cells[i]) + 2);
    }
    if (detailBudget > 3) b += cropRunes(cells[last], detailBudget);
    let line = b.replace(/\s+$/, "");
    if (dim && tty) line = dimOn + line + dimOff;
    lines.push(line);
  };
  printRow(header, false);
  sessions.forEach((s, i) => printRow(rows[i], !!(s.acked || s.hidden)));
  return lines.join("\n");
}
