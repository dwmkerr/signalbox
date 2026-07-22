// Codex CLI adapter: hook payload -> event mapping (specs/adapters.md). Codex's
// hooks (config `[features] hooks = true`, ~/.codex/hooks.json) mirror Claude
// Code's: JSON on stdin, snake_case fields, PascalCase `hook_event_name`. Unlike
// Claude, the Stop payload carries `last_assistant_message` directly, so reply
// capture needs no transcript read.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cropPrompt, cropReply, Busy, Done, Attention, Ended } from "./event";
import { stripHarness } from "./claude";

// Subset of the Codex hook stdin JSON that signalbox consumes; unknown fields
// are ignored so payload growth is harmless.
export interface CodexHook {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  // UserPromptSubmit: the text the user just submitted.
  prompt?: string;
  // Stop: the final assistant message of the turn (Codex provides it inline).
  last_assistant_message?: string | null;
  // PermissionRequest: what Codex wants to run. tool_input carries the command
  // and often Codex's own one-line description of the ask.
  tool_name?: string;
  tool_input?: { command?: unknown; description?: string } & Record<string, unknown>;
  reason?: string;
}

export interface Mapped {
  eventType: string;
  reason: string;
  detail: string;
}

// mapCodexHook translates a hook payload per the adapter table. null means the
// hook is deliberately ignored - the caller must still exit 0. The events
// mirror Claude's: a submitted prompt or a fresh session is busy, a completed
// turn is done, a permission request is the blocked "needs you" state, and a
// session end removes the row. clearEnds=false keeps a cleared session on the
// board (mapped to done), the same guard as Claude's - inert unless Codex sends
// a SessionEnd with reason "clear".
export function mapCodexHook(h: CodexHook, clearEnds = true): Mapped | null {
  switch (h.hook_event_name) {
    case "SessionStart":
      return { eventType: Busy, reason: "session_start", detail: "" };
    case "UserPromptSubmit":
      return { eventType: Busy, reason: "", detail: cropPrompt(stripHarness(h.prompt || "")) };
    case "Stop":
      return { eventType: Done, reason: "stop", detail: "" };
    case "PermissionRequest":
      // Codex is blocked waiting on you to approve a command or tool call.
      return { eventType: Attention, reason: "permission_request", detail: "" };
    case "SessionEnd":
      if (!clearEnds && h.reason === "clear") {
        return { eventType: Done, reason: "clear", detail: "" };
      }
      return { eventType: Ended, reason: "session_end", detail: "" };
  }
  return null;
}

// codexReply is the breadcrumb the board shows once a session is no longer busy.
// On Stop it is the turn's final assistant text. On PermissionRequest - the state
// a Codex session dwells in while it asks approval on nearly every command - it
// is what Codex wants to do, so the row shows the live ask rather than falling
// back to a stale prompt. Empty on any miss so the reducer's carry keeps the
// previous value.
export function codexReply(h: CodexHook): string {
  if (h.hook_event_name === "Stop") {
    const msg = h.last_assistant_message;
    return msg ? cropReply(stripHarness(msg)) : "";
  }
  if (h.hook_event_name === "PermissionRequest") {
    return cropReply(permissionAsk(h));
  }
  return "";
}

// A short "what needs you" line for a permission request: Codex's own
// description if it gave one, else the command, else the tool name.
function permissionAsk(h: CodexHook): string {
  const input = h.tool_input;
  if (input && typeof input === "object") {
    const desc = typeof input.description === "string" ? input.description.trim() : "";
    if (desc) return desc;
    const cmd = commandText(input.command);
    if (cmd) return `Wants to run: ${cmd}`;
  }
  return h.tool_name ? `Wants to use ${h.tool_name}` : "";
}

function commandText(cmd: unknown): string {
  if (typeof cmd === "string") return cmd.trim();
  if (Array.isArray(cmd)) return cmd.map(String).join(" ").trim();
  return "";
}

// The session index only grows one small line per named session, but cap the
// read anyway - a hook must stay fast whatever is on disk.
const indexTailBytes = 256 << 10;

// codexSessionName returns the session's thread name from Codex's
// ~/.codex/session_index.jsonl - the file its /rename writes, one JSON line
// per named session ({ id, thread_name, updated_at }). The last entry for the
// id wins. Empty on any miss, so the title falls back to the cwd folder name.
export function codexSessionName(sessionId: string, indexPath?: string): string {
  const p = indexPath ?? join(homedir(), ".codex", "session_index.jsonl");
  if (!sessionId || !existsSync(p)) return "";
  let text: string;
  try {
    const size = statSync(p).size;
    const buf = readFileSync(p);
    text = size > indexTailBytes ? buf.subarray(size - indexTailBytes).toString("utf8") : buf.toString("utf8");
  } catch {
    return "";
  }
  let name = "";
  for (const line of text.split("\n")) {
    if (!line.includes(sessionId)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.id === sessionId && typeof entry.thread_name === "string") name = entry.thread_name;
    } catch {
      // partial or malformed line - skip
    }
  }
  return cropPrompt(name.trim());
}
