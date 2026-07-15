// Cursor adapter: Cursor 1.7 Hooks payload → event mapping (specs/adapters.md).
// Cursor Hooks are beta (https://cursor.com/docs/hooks); every payload field
// this file reads is matched to the documented shape, but the transcript
// format in particular is unverified - flagged inline so it can be checked
// empirically. Unknown fields are ignored so payload growth is harmless.

import { cropReply, Busy, Done, Attention, Error as ErrorType, Ended, type Origin } from "./event";
import { stripHarness, lastAssistantText, type Mapped } from "./claude";

// Cursor's stable macOS bundle id (Cursor ships as a ToDesktop build). Captured
// into the origin so jump raises the right app; confirmed via
// https://forum.cursor.com/t/cursor-bundle-identifier/779.
export const cursorBundle = "com.todesktop.230313mzl4w4u92";

// VS Code's bundle id - the default editor bundle when a VS Code-family
// terminal is detected but the exact fork cannot be identified.
export const vscodeBundle = "com.microsoft.VSCode";

// editorTerminalOrigin detects an agent running inside an editor's integrated
// terminal (VS Code, Cursor, and other VS Code forks all set TERM_PROGRAM to
// "vscode"). There is no tmux pane to jump to, so the origin carries the
// editor's bundle id and jump raises the editor window instead. The kind stays
// "cursor" - it is the generic Electron-editor origin (renaming it would break
// events already on disk).
export function editorTerminalOrigin(env: Record<string, string | undefined>): Origin | null {
  if (env.TERM_PROGRAM !== "vscode") return null;
  // macOS stamps the launching app's bundle id on its child processes; that is
  // what tells Cursor apart from VS Code (both report TERM_PROGRAM "vscode"),
  // and lets any other fork pass its own id straight through to the jump.
  // Absent (non-macOS, scrubbed env), assume real VS Code.
  const bundle = env.__CFBundleIdentifier || vscodeBundle;
  return { kind: "cursor", cursor: { bundle } };
}

// Subset of the Cursor hook stdin JSON signalbox consumes. Field names follow
// the beta Hooks docs (conversation_id, hook_event_name, workspace_roots,
// transcript_path, status). `status` rides on the `stop` event.
export interface CursorHook {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  // On `stop`: "completed" | "aborted" | "error" (documented). Anything else
  // (or absent) is treated as a normal finish.
  status?: string;
  transcript_path?: string;
  user_email?: string;
}

// mapCursorHook translates a Cursor hook payload per the adapter table. null
// means the hook is deliberately ignored - the caller must still exit 0.
export function mapCursorHook(h: CursorHook): Mapped | null {
  switch (h.hook_event_name) {
    case "sessionStart":
      return { eventType: Busy, reason: "session_start", detail: "" };
    case "stop": {
      // Cursor carries the outcome on `status`; map each to the matching
      // lifecycle state, defaulting a missing/unknown status to a plain finish
      // so a payload change can never strand a session as "busy".
      switch (h.status) {
        case "aborted":
          return { eventType: Ended, reason: "aborted", detail: "" };
        case "error":
          return { eventType: ErrorType, reason: "error", detail: "" };
        default:
          return { eventType: Done, reason: "stop", detail: "" };
      }
    }
    // Cursor has no dedicated "needs you" event; the ask/permission path fires
    // beforeShellExecution / beforeMCPExecution, so those are the "blocked on
    // you" signal - mapped to attention like Claude's permission notifications.
    case "beforeShellExecution":
      return { eventType: Attention, reason: "shell_permission", detail: "" };
    case "beforeMCPExecution":
      return { eventType: Attention, reason: "mcp_permission", detail: "" };
    // A sub-agent finishing is a "done" signal for the session; mapped to done
    // rather than ignored so background sub-agent completions still surface.
    case "subagentStop":
      return { eventType: Done, reason: "subagent_stop", detail: "" };
  }
  return null;
}

// cursorWorkspace is the project path driving the title and the jump's window-
// title match: the first workspace root.
export function cursorWorkspace(h: CursorHook): string {
  return h.workspace_roots?.[0] ?? "";
}

// cursorReply best-effort extracts the agent's last message for hooks that mark
// it as having finished speaking (stop / subagentStop). Cursor's transcript
// format is UNVERIFIED (Hooks are beta); this assumes the same JSONL shape as
// Claude's transcript and returns "" on any mismatch - the reducer's carry then
// keeps the previous reply, so a wrong guess degrades quietly rather than
// showing garbage. Verify the transcript shape empirically and adjust.
export function cursorReply(h: CursorHook): string {
  const speaking = h.hook_event_name === "stop" || h.hook_event_name === "subagentStop";
  if (!speaking || !h.transcript_path) return "";
  return cropReply(stripHarness(lastAssistantText(h.transcript_path)));
}
