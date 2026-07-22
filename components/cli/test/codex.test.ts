import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCodexHook, codexReply, codexSessionName } from "../src/codex";

describe("mapCodexHook", () => {
  const cases: [any, { eventType: string; reason: string; detail?: string } | null][] = [
    [{ hook_event_name: "SessionStart" }, { eventType: "busy", reason: "session_start" }],
    [
      { hook_event_name: "UserPromptSubmit", prompt: "add a codex adapter" },
      { eventType: "busy", reason: "", detail: "add a codex adapter" },
    ],
    [{ hook_event_name: "Stop", last_assistant_message: "done" }, { eventType: "done", reason: "stop" }],
    [{ hook_event_name: "PermissionRequest" }, { eventType: "attention", reason: "permission_request" }],
    [{ hook_event_name: "SessionEnd" }, { eventType: "ended", reason: "session_end" }],
    [{ hook_event_name: "SessionEnd", reason: "clear" }, { eventType: "ended", reason: "session_end" }],
    // Anything else (a PreToolUse, an empty payload) is ignored - the caller
    // still exits 0.
    [{ hook_event_name: "PreToolUse" }, null],
    [{ hook_event_name: "PostToolUse" }, null],
    [{}, null],
  ];
  for (const [input, want] of cases) {
    test(`${input.hook_event_name ?? "empty"}`, () => {
      const got = mapCodexHook(input);
      if (want === null) {
        expect(got).toBeNull();
      } else {
        expect(got?.eventType).toBe(want.eventType);
        expect(got?.reason).toBe(want.reason);
        if (want.detail !== undefined) expect(got?.detail).toBe(want.detail);
      }
    });
  }
});

describe("codexReply", () => {
  test("Stop returns the inline last_assistant_message", () => {
    expect(codexReply({ hook_event_name: "Stop", last_assistant_message: "all done" })).toBe("all done");
  });
  test("harness bracket tags are stripped, like the prompt", () => {
    expect(codexReply({ hook_event_name: "Stop", last_assistant_message: "[Image #1] real reply" })).toBe("real reply");
  });
  test("non-Stop hooks read no reply (would be stale)", () => {
    expect(codexReply({ hook_event_name: "UserPromptSubmit", last_assistant_message: "x" })).toBe("");
    expect(codexReply({ hook_event_name: "PermissionRequest", last_assistant_message: "x" })).toBe("");
  });
  test("empty when the message is missing or null", () => {
    expect(codexReply({ hook_event_name: "Stop" })).toBe("");
    expect(codexReply({ hook_event_name: "Stop", last_assistant_message: null })).toBe("");
  });

  // The permission-request breadcrumb: a Codex session sits in attention while it
  // asks approval, so the row must show what it wants to do, not a stale prompt.
  test("PermissionRequest shows Codex's own description when present", () => {
    expect(codexReply({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "screencapture -x /tmp/x.png", description: "May I capture the screen?" },
    })).toBe("May I capture the screen?");
  });
  test("PermissionRequest falls back to the command", () => {
    expect(codexReply({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "osascript -e 'tell application \"UTM\" to activate'" },
    })).toBe("Wants to run: osascript -e 'tell application \"UTM\" to activate'");
  });
  test("PermissionRequest falls back to the tool name", () => {
    expect(codexReply({ hook_event_name: "PermissionRequest", tool_name: "WebSearch" }))
      .toBe("Wants to use WebSearch");
  });
});

describe("mapCodexHook clearEnds", () => {
  test("clearEnds=false keeps a cleared session as done", () => {
    const got = mapCodexHook({ hook_event_name: "SessionEnd", reason: "clear" }, false);
    expect(got?.eventType).toBe("done");
    expect(got?.reason).toBe("clear");
  });
  test("clearEnds=false still ends a non-clear SessionEnd", () => {
    const got = mapCodexHook({ hook_event_name: "SessionEnd", reason: "exit" }, false);
    expect(got?.eventType).toBe("ended");
  });
});

describe("codexSessionName", () => {
  // ~/.codex/session_index.jsonl: one JSON line per named session, written by
  // Codex's /rename. The last entry for an id wins.
  test("reads the thread name for the session id", () => {
    const p = join(mkdtempSync(join(tmpdir(), "sb-codex-")), "session_index.jsonl");
    writeFileSync(p, '{"id":"abc","thread_name":"signalbox-linux","updated_at":"2026-07-22T05:56:25Z"}\n');
    expect(codexSessionName("abc", p)).toBe("signalbox-linux");
  });
  test("last rename wins", () => {
    const p = join(mkdtempSync(join(tmpdir(), "sb-codex-")), "session_index.jsonl");
    writeFileSync(p, '{"id":"abc","thread_name":"old-name"}\n{"id":"abc","thread_name":"new-name"}\n');
    expect(codexSessionName("abc", p)).toBe("new-name");
  });
  test("empty for an unknown id or missing file", () => {
    const p = join(mkdtempSync(join(tmpdir(), "sb-codex-")), "session_index.jsonl");
    writeFileSync(p, '{"id":"other","thread_name":"x"}\n');
    expect(codexSessionName("abc", p)).toBe("");
    expect(codexSessionName("abc", p + ".missing")).toBe("");
  });
});
