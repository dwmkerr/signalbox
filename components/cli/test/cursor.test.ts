import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCursorHook, cursorReply, cursorWorkspace, cursorBundle, vscodeBundle, editorTerminalOrigin } from "../src/cursor";

describe("mapCursorHook", () => {
  const cases: [any, { eventType: string; reason: string } | null][] = [
    [{ hook_event_name: "sessionStart" }, { eventType: "busy", reason: "session_start" }],
    [{ hook_event_name: "stop", status: "completed" }, { eventType: "done", reason: "stop" }],
    [{ hook_event_name: "stop", status: "aborted" }, { eventType: "ended", reason: "aborted" }],
    [{ hook_event_name: "stop", status: "error" }, { eventType: "error", reason: "error" }],
    // Missing/unknown status defaults to a plain finish, never a stuck "busy".
    [{ hook_event_name: "stop" }, { eventType: "done", reason: "stop" }],
    [{ hook_event_name: "beforeShellExecution" }, { eventType: "attention", reason: "shell_permission" }],
    [{ hook_event_name: "beforeMCPExecution" }, { eventType: "attention", reason: "mcp_permission" }],
    [{ hook_event_name: "subagentStop" }, { eventType: "done", reason: "subagent_stop" }],
    // subagentStart and anything else is ignored.
    [{ hook_event_name: "subagentStart" }, null],
    [{ hook_event_name: "afterFileEdit" }, null],
    [{}, null],
  ];
  for (const [input, want] of cases) {
    test(`${input.hook_event_name ?? "empty"}/${input.status ?? ""}`, () => {
      const got = mapCursorHook(input);
      if (want === null) expect(got).toBeNull();
      else {
        expect(got?.eventType).toBe(want.eventType);
        expect(got?.reason).toBe(want.reason);
      }
    });
  }
});

describe("cursorWorkspace", () => {
  test("first workspace root", () => {
    expect(cursorWorkspace({ workspace_roots: ["/home/me/proj", "/other"] })).toBe("/home/me/proj");
  });
  test("empty when absent", () => {
    expect(cursorWorkspace({})).toBe("");
  });
});

describe("cursorBundle", () => {
  test("is Cursor's stable macOS bundle id", () => {
    expect(cursorBundle).toBe("com.todesktop.230313mzl4w4u92");
  });
});

describe("editorTerminalOrigin", () => {
  test("null outside an editor terminal", () => {
    expect(editorTerminalOrigin({})).toBeNull();
    expect(editorTerminalOrigin({ TERM_PROGRAM: "iTerm.app" })).toBeNull();
  });
  test("VS Code terminal carries VS Code's bundle", () => {
    const o = editorTerminalOrigin({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.microsoft.VSCode" });
    expect(o).toEqual({ kind: "cursor", cursor: { bundle: vscodeBundle } });
  });
  test("Cursor terminal carries Cursor's bundle (Cursor also reports vscode)", () => {
    const o = editorTerminalOrigin({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: cursorBundle });
    expect(o).toEqual({ kind: "cursor", cursor: { bundle: cursorBundle } });
  });
  test("missing bundle id defaults to VS Code", () => {
    const o = editorTerminalOrigin({ TERM_PROGRAM: "vscode" });
    expect(o?.cursor?.bundle).toBe(vscodeBundle);
  });
  test("an unknown fork's bundle id passes through", () => {
    const o = editorTerminalOrigin({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.exafunction.windsurf" });
    expect(o?.cursor?.bundle).toBe("com.exafunction.windsurf");
  });
});

describe("cursorReply", () => {
  // Best-effort, transcript shape assumed to match Claude's JSONL (UNVERIFIED).
  test("stop reads the last assistant text", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "all done" } })
    );
    expect(cursorReply({ hook_event_name: "stop", transcript_path: p })).toBe("all done");
  });
  test("subagentStop reads the transcript too", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "sub reply" } })
    );
    expect(cursorReply({ hook_event_name: "subagentStop", transcript_path: p })).toBe("sub reply");
  });
  test("permission events do not read a reply (stale text)", () => {
    expect(cursorReply({ hook_event_name: "beforeShellExecution", transcript_path: "/x.jsonl" })).toBe("");
  });
  test("no transcript path is empty", () => {
    expect(cursorReply({ hook_event_name: "stop" })).toBe("");
  });
});
