import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapClaudeHook, stripHarness, claudeReply, lastAssistantText, sessionName,
} from "../src/claude";

const fixture = join(import.meta.dir, "testdata", "transcript.jsonl");

describe("mapClaudeHook", () => {
  const cases: [any, { eventType: string; reason: string } | null][] = [
    [{ hook_event_name: "SessionStart" }, { eventType: "busy", reason: "session_start" }],
    [{ hook_event_name: "Stop" }, { eventType: "done", reason: "stop" }],
    [{ hook_event_name: "Notification", notification_type: "permission_prompt" }, { eventType: "attention", reason: "permission_prompt" }],
    [{ hook_event_name: "Notification", notification_type: "idle_prompt" }, { eventType: "done", reason: "idle" }],
    [{ hook_event_name: "Notification", notification_type: "elicitation_dialog" }, { eventType: "attention", reason: "elicitation_dialog" }],
    // Unknown notification types default to attention (Claude wants you) -
    // only idle_prompt is "done".
    [{ hook_event_name: "Notification", notification_type: "something_else" }, { eventType: "attention", reason: "something_else" }],
    // Current Claude Code sends no type, only a message. A permission message
    // is attention; an idle/waiting message is done.
    [{ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }, { eventType: "attention", reason: "notification" }],
    [{ hook_event_name: "Notification", message: "Claude is waiting for your input" }, { eventType: "done", reason: "idle" }],
    [{ hook_event_name: "Notification" }, { eventType: "attention", reason: "notification" }],
    [{ hook_event_name: "StopFailure", error_type: "max_turns" }, { eventType: "error", reason: "max_turns" }],
    [{ hook_event_name: "SessionEnd" }, { eventType: "ended", reason: "session_end" }],
    [{ hook_event_name: "PreToolUse" }, null],
  ];
  for (const [input, want] of cases) {
    test(`${input.hook_event_name}/${input.notification_type ?? ""}`, () => {
      const got = mapClaudeHook(input);
      if (want === null) expect(got).toBeNull();
      else {
        expect(got?.eventType).toBe(want.eventType);
        expect(got?.reason).toBe(want.reason);
      }
    });
  }

  test("UserPromptSubmit carries the cropped prompt", () => {
    const got = mapClaudeHook({ hook_event_name: "UserPromptSubmit", prompt: "fix\nthe bug" });
    expect(got?.eventType).toBe("busy");
    expect(got?.detail).toBe("fix the bug");
  });

  test("UserPromptSubmit falls back to raw_prompt", () => {
    const got = mapClaudeHook({ hook_event_name: "UserPromptSubmit", raw_prompt: "older payload" });
    expect(got?.detail).toBe("older payload");
  });

  test("SessionEnd reason clear ends by default", () => {
    const got = mapClaudeHook({ hook_event_name: "SessionEnd", reason: "clear" });
    expect(got?.eventType).toBe("ended");
  });

  test("SessionEnd reason clear maps to done when clearEnds=false", () => {
    const got = mapClaudeHook({ hook_event_name: "SessionEnd", reason: "clear" }, false);
    expect(got?.eventType).toBe("done");
    expect(got?.reason).toBe("clear");
  });

  test("SessionEnd other reasons still end when clearEnds=false", () => {
    const got = mapClaudeHook({ hook_event_name: "SessionEnd", reason: "exit" }, false);
    expect(got?.eventType).toBe("ended");
  });
});

describe("stripHarness", () => {
  test("strips leading bracket tags", () => {
    expect(stripHarness("[Image #1] fix the bug")).toBe("fix the bug");
    expect(stripHarness("[Image #1][Pasted text] do it")).toBe("do it");
  });
  test("drops harness XML entirely", () => {
    expect(stripHarness("<system-reminder>ping</system-reminder>")).toBe("");
    expect(stripHarness("[Tag] <task-notification>x</task-notification>")).toBe("");
  });
  test("keeps a prompt that merely opens with a long bracket run", () => {
    expect(stripHarness(`[${"x".repeat(60)}] hello`)).toBe(`[${"x".repeat(60)}] hello`);
  });
  test("empty stays empty", () => {
    expect(stripHarness("   ")).toBe("");
  });
});

describe("lastAssistantText", () => {
  test("fixture: finds the last text-bearing assistant entry", () => {
    const got = lastAssistantText(fixture);
    expect(got.startsWith("Done - both changes are in.")).toBe(true);
  });

  test("skips trailing tool_use-only entries and joins text blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "x" }] } }),
      ].join("\n")
    );
    expect(lastAssistantText(p)).toBe("first second");
  });

  test("plain string content works", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, JSON.stringify({ type: "assistant", message: { role: "assistant", content: "plain reply" } }));
    expect(lastAssistantText(p)).toBe("plain reply");
  });

  test("missing file is empty, never throws", () => {
    expect(lastAssistantText("/nonexistent/x.jsonl")).toBe("");
  });

  test("bounded tail: finds a message at the end of a large file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    const p = join(dir, "big.jsonl");
    const filler = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(500) } });
    const lines = Array(300).fill(filler);
    lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the end" }] } }));
    writeFileSync(p, lines.join("\n"));
    expect(lastAssistantText(p)).toBe("the end");
  });
});

describe("claudeReply", () => {
  test("Stop reads the transcript", () => {
    const got = claudeReply({ hook_event_name: "Stop", transcript_path: fixture });
    expect(got.startsWith("Done - both changes are in.")).toBe(true);
  });
  test("idle_prompt reads the transcript", () => {
    const got = claudeReply({ hook_event_name: "Notification", notification_type: "idle_prompt", transcript_path: fixture });
    expect(got).not.toBe("");
  });
  test("typeless idle message reads the transcript", () => {
    // Current Claude Code sends no notification_type, only a message; an idle
    // message must refresh the reply just like a typed idle_prompt.
    const got = claudeReply({ hook_event_name: "Notification", message: "Claude is waiting for your input", transcript_path: fixture });
    expect(got.startsWith("Done - both changes are in.")).toBe(true);
  });
  test("permission_prompt does not (stale text)", () => {
    const got = claudeReply({ hook_event_name: "Notification", notification_type: "permission_prompt", transcript_path: fixture });
    expect(got).toBe("");
  });
  test("typeless permission message does not (stale text)", () => {
    const got = claudeReply({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash", transcript_path: fixture });
    expect(got).toBe("");
  });
  test("no transcript path is empty", () => {
    expect(claudeReply({ hook_event_name: "Stop" })).toBe("");
  });
});

describe("sessionName", () => {
  test("last custom-title wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "custom-title", customTitle: "first name" }),
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "custom-title", customTitle: "final name" }),
      ].join("\n")
    );
    expect(sessionName(p)).toBe("final name");
  });
  test("no custom-title is empty", () => {
    expect(sessionName(fixture)).toBe("");
  });
  test("missing file is empty", () => {
    expect(sessionName("/nonexistent/x.jsonl")).toBe("");
  });
});
