// Claude Code adapter: hook payload → event mapping (specs/adapters.md) and
// bounded transcript reads for reply capture and /rename session names.

import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { cropPrompt, cropReply, Busy, Done, Attention, Error as ErrorType, Ended } from "./event";

// Subset of Claude Code hook stdin JSON that signalbox consumes; unknown
// fields are ignored so hook payload growth is harmless.
export interface ClaudeHook {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  notification_type?: string;
  // Current Claude Code sends a free-text `message` on Notification, not a
  // typed `notification_type`; both are read so old and new payloads work.
  message?: string;
  error_type?: string;
  reason?: string;
  prompt?: string;
  raw_prompt?: string;
  transcript_path?: string;
  // PermissionRequest / PreToolUse: the pending tool call itself.
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// Harness-prepended bracket tags ("[Image #1]" etc., possibly repeated) at
// the start of a prompt. Each tag bounded at 40 chars so a real prompt that
// merely opens with "[" cannot be swallowed by a runaway match.
const bracketTags = /^(?:\s*\[[^\]]{1,40}\])+/;

// stripHarness applies the contract's bracket-tag/XML filter, shared by
// detail and reply: strip leading bracket tags, then drop the text entirely
// when what remains is harness XML (starts with "<") or empty, so the carry
// rule preserves the last real value instead.
export function stripHarness(s: string): string {
  const rest = s.replace(bracketTags, "").trim();
  if (rest === "" || rest.startsWith("<")) return "";
  return rest;
}

function filterDetail(prompt: string): string {
  return cropPrompt(stripHarness(prompt));
}

// isIdleNotification is the single "finished, over to you" test: a Notification
// that is either the typed idle_prompt or (current Claude Code sends no type) a
// typeless message whose text reads as idle/finished. Shared by mapClaudeHook
// (→ done) and claudeReply (→ read the fresh transcript reply) so the two can
// never disagree about when the agent has stopped speaking.
const idleMessage = /waiting for your input|idle|finished|no longer/;
export function isIdleNotification(h: ClaudeHook): boolean {
  if (h.hook_event_name !== "Notification") return false;
  return (
    h.notification_type === "idle_prompt" ||
    (!h.notification_type && idleMessage.test((h.message ?? "").toLowerCase()))
  );
}

export interface Mapped {
  eventType: string;
  reason: string;
  detail: string;
}

// mapClaudeHook translates a hook payload per the adapter table. null means
// the hook is deliberately ignored - the caller must still exit 0.
// clearEnds=false keeps `/clear`ed sessions on the board (mapped to done)
// instead of removing them - a /clear starts a fresh session id, but the
// old exchange can still be worth seeing.
export function mapClaudeHook(h: ClaudeHook, clearEnds = true): Mapped | null {
  switch (h.hook_event_name) {
    case "SessionStart":
      return { eventType: Busy, reason: "session_start", detail: "" };
    case "UserPromptSubmit":
      return { eventType: Busy, reason: "", detail: filterDetail(h.prompt || h.raw_prompt || "") };
    case "Stop":
      return { eventType: Done, reason: "stop", detail: "" };
    case "Notification": {
      // Notifications split two ways: "finished, over to you" (idle → done) and
      // "blocked, waiting on you" (permission/elicitation/anything else →
      // attention). Current Claude Code sends no `notification_type`, only a
      // `message`, so idle is matched by type OR by the message text; every
      // other notification defaults to attention. Erring toward attention (over
      // dropping the hook) keeps the "needs you" state honest as Claude Code
      // changes these payloads between versions.
      if (isIdleNotification(h)) return { eventType: Done, reason: "idle", detail: "" };
      return { eventType: Attention, reason: h.notification_type || "notification", detail: "" };
    }
    case "PermissionRequest":
      // The permission dialog is up: the authoritative blocked-on-you signal,
      // with the actual ask carried in reply (claudeReply formats it). Older
      // Claude Code never fires this and degrades to the bare Notification.
      // AskUserQuestion rides the permission system, so it arrives here too -
      // keep its reason "question" so the flavor survives whichever of the
      // two hooks lands last.
      return {
        eventType: Attention,
        reason: h.tool_name === "AskUserQuestion" ? "question" : "permission_request",
        detail: "",
      };
    case "PreToolUse":
      // Matcher-scoped to AskUserQuestion in hooks-settings.json: the question
      // never reaches the transcript or the Notification payload while it
      // waits, so this hook is the only passive source of the question text.
      // Any other tool arriving here (hand-edited settings) is ignored -
      // PreToolUse fires for every tool call and must not flood the board.
      if (h.tool_name === "AskUserQuestion") {
        return { eventType: Attention, reason: "question", detail: "" };
      }
      return null;
    case "StopFailure":
      return { eventType: ErrorType, reason: h.error_type ?? "", detail: "" };
    case "SessionEnd":
      if (!clearEnds && h.reason === "clear") {
        return { eventType: Done, reason: "clear", detail: "" };
      }
      return { eventType: Ended, reason: "session_end", detail: "" };
  }
  return null;
}

// claudeReply extracts the reply for hooks that mark the agent as having
// finished speaking - Stop, or any idle Notification (by the SAME test
// mapClaudeHook uses, so typeless idle notifications on current Claude Code
// refresh the reply too). Permission/attention notifications are excluded on
// purpose: there the transcript's last line is stale, not the reply. Bounded
// tail read, filtered like detail, cropped at this emitter; empty on any miss
// so the reducer's carry keeps the previous reply.
export function claudeReply(h: ClaudeHook): string {
  const speaking = h.hook_event_name === "Stop" || isIdleNotification(h);
  if (speaking && h.transcript_path) {
    return cropReply(stripHarness(lastAssistantText(h.transcript_path)));
  }
  // A pending tool call: the reply is the actual ask, formatted and cropped
  // here at the emitter (asks travel to the phone - specs/adapters.md).
  if (h.hook_event_name === "PermissionRequest" || h.hook_event_name === "PreToolUse") {
    return cropReply(formatAsk(h.tool_name ?? "", h.tool_input ?? {}));
  }
  // A permission/attention notification: show the notification message (it names
  // what Claude needs) rather than let the row fall back to a stale prompt. The
  // transcript is deliberately NOT read here - on a permission prompt its last
  // line is stale, not the ask. Empty message keeps the prompt fallback. Rarely
  // seen when running with permissions bypassed.
  if (h.hook_event_name === "Notification" && !isIdleNotification(h)) {
    return cropReply(stripHarness(h.message || ""));
  }
  return "";
}

// formatAsk renders a pending tool call as the ask the user actually faces:
// a question with its option labels, or the tool and its target. Never file
// contents - a Write/Edit input is summarized to its path (specs/adapters.md).
export function formatAsk(tool: string, input: Record<string, unknown>): string {
  if (tool === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const parts: string[] = [];
    for (const q of questions) {
      if (typeof q?.question !== "string" || !q.question) continue;
      const labels = (Array.isArray(q.options) ? q.options : [])
        .map((o: unknown) => (typeof o === "string" ? o : (o as any)?.label))
        .filter((l: unknown): l is string => typeof l === "string" && l !== "");
      parts.push(labels.length ? `${q.question} (${labels.join(" / ")})` : q.question);
    }
    return parts.join(" · ");
  }
  if (!tool) return "";
  // One target string per tool, checked in specificity order. command before
  // description so a Bash ask shows what would RUN, not its summary; file
  // paths cover Write/Edit/Read without ever touching their content field.
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const target = str("command") || str("file_path") || str("path") || str("url") || str("description") || str("prompt");
  return target ? `${tool}: ${target}` : tool;
}

// Bounds how much of a transcript the hook path reads: the last assistant
// message is always within the final few KB, and a hook must stay fast
// whatever the file size.
const transcriptTailBytes = 64 << 10;

function readWindow(path: string, offset: number, length: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function fileSize(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return -1;
  }
  try {
    return fstatSync(fd).size;
  } catch {
    return -1;
  } finally {
    closeSync(fd);
  }
}

// lastAssistantText returns the text of the last assistant message in the
// transcript JSONL, reading only the file's tail. Entries without
// displayable text (tool_use-only turns) are skipped backwards. Empty on
// any failure - reply capture must never break the hook path.
export function lastAssistantText(path: string): string {
  const size = fileSize(path);
  if (size < 0) return "";
  const truncated = size > transcriptTailBytes;
  const off = truncated ? size - transcriptTailBytes : 0;
  const data = readWindow(path, off, transcriptTailBytes);
  if (!data) return "";
  let lines = data.toString("utf8").split("\n");
  // The seek landed mid-line, so the first fragment is not valid JSON.
  if (truncated && lines.length > 0) lines = lines.slice(1);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" && entry?.message?.role !== "assistant") continue;
    const text = contentText(entry?.message?.content);
    if (text) return text;
  }
  return "";
}

// contentText extracts displayed text from a message content payload: only
// text blocks count - tool_use and thinking blocks are machinery the user
// never saw as the reply.
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(" ");
}

// sessionName returns the explicitly-set session name ("custom-title" entry,
// written by /rename) or "". Renames happen at session start or recently, so
// a bounded head+tail window finds them without reading a large transcript
// on the hook path. The LAST occurrence wins.
export function sessionName(path: string): string {
  const size = fileSize(path);
  if (size < 0) return "";

  let name = "";
  const scan = (data: string) => {
    for (const line of data.split("\n")) {
      if (!line.includes('"custom-title"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "custom-title" && entry.customTitle) name = entry.customTitle;
      } catch {
        // partial or malformed line - skip
      }
    }
  };

  const head = readWindow(path, 0, transcriptTailBytes);
  if (head) scan(head.toString("utf8"));

  if (size > 2 * transcriptTailBytes) {
    const tail = readWindow(path, size - transcriptTailBytes, transcriptTailBytes);
    if (tail) {
      const text = tail.toString("utf8");
      // Drop the partial first line after the seek so a name split across
      // the boundary can't half-parse.
      const idx = text.indexOf("\n");
      if (idx >= 0) scan(text.slice(idx + 1));
    }
  }
  return cropPrompt(name);
}
