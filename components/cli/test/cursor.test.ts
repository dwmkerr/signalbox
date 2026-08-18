import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCursorHook, cursorReply, cursorPrompt, cursorWorkspace, cursorBundle, vscodeBundle, editorTerminalOrigin, editorHost, hostPrefixedAgent } from "../src/cursor";
import { agentFamily } from "../src/event";

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

describe("host-prefixed agent (editor-hosted display name)", () => {
  // The producer rule: a Claude session shows under its editor host's icon via
  // a display-agent prefix, while session_key stays keyed on the "claude"
  // family so the same session never splits across terminals.
  const cursorEnv = { TERM_PROGRAM: "vscode", __CFBundleIdentifier: cursorBundle };
  const vscodeEnv = { TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.microsoft.VSCode" };
  const forkEnv = { TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.exafunction.windsurf" };

  test("plain terminal keeps the bare agent family", () => {
    expect(editorHost({})).toBeNull();
    expect(editorHost({ TERM_PROGRAM: "iTerm.app" })).toBeNull();
    expect(hostPrefixedAgent("claude", {})).toBe("claude");
  });
  test("Cursor's integrated terminal prefixes cursor/", () => {
    expect(editorHost(cursorEnv)).toBe("cursor");
    expect(hostPrefixedAgent("claude", cursorEnv)).toBe("cursor/claude");
  });
  test("VS Code's integrated terminal prefixes vscode/", () => {
    expect(editorHost(vscodeEnv)).toBe("vscode");
    expect(hostPrefixedAgent("claude", vscodeEnv)).toBe("vscode/claude");
  });
  test("an unrecognized vscode fork is shown as VS Code", () => {
    expect(editorHost(forkEnv)).toBe("vscode");
    expect(hostPrefixedAgent("claude", forkEnv)).toBe("vscode/claude");
  });
  test("session_key family is unchanged across every host", () => {
    // The display agent varies with the host, but the family that anchors
    // session_key (claude:<id>) is invariant - the session cannot split.
    for (const env of [{}, cursorEnv, vscodeEnv, forkEnv]) {
      expect(agentFamily(hostPrefixedAgent("claude", env))).toBe("claude");
    }
  });
});

describe("cursorReply", () => {
  test("cursor returns the reply as raw markdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-"));
    const p = join(dir, "t.jsonl");
    const reply = "Line one\n\n- bullet\n- bullet";
    writeFileSync(
      p,
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: reply } })
    );
    expect(cursorReply({ hook_event_name: "stop", transcript_path: p })).toBe(reply);
  });
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

  // The real Cursor shape (verified from ~/.cursor/projects/.../agent-transcripts):
  // role at the top level, text in content blocks - the shape lastAssistantText
  // previously skipped, leaving Cursor replies empty.
  test("reads Cursor's real transcript shape (top-level role, content blocks)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>\nhi\n</user_query>" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Wired the tests into CI." }] } }),
        JSON.stringify({ status: "completed", type: "turn_ended" }),
      ].join("\n")
    );
    expect(cursorReply({ hook_event_name: "stop", transcript_path: p })).toBe("Wired the tests into CI.");
  });
});

describe("cursorPrompt", () => {
  const cursorTranscript = (userText: string, asstText = "ok") =>
    [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: userText }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: asstText }] } }),
    ].join("\n");

  test("unwraps <user_query> and strips the <timestamp> harness", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      cursorTranscript("<timestamp>Monday, Jul 13, 2026, 9:22 AM</timestamp>\n<user_query>\nadd a pin toggle to the jumplist\n</user_query>")
    );
    expect(cursorPrompt({ hook_event_name: "stop", transcript_path: p })).toBe("add a pin toggle to the jumplist");
  });

  test("subagentStop reads the prompt too", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, cursorTranscript("<user_query>\nfix the flaky test\n</user_query>"));
    expect(cursorPrompt({ hook_event_name: "subagentStop", transcript_path: p })).toBe("fix the flaky test");
  });

  test("falls back to raw text when there is no <user_query> wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, cursorTranscript("just the plain prompt"));
    expect(cursorPrompt({ hook_event_name: "stop", transcript_path: p })).toBe("just the plain prompt");
  });

  test("permission events do not read a prompt (transcript incomplete)", () => {
    expect(cursorPrompt({ hook_event_name: "beforeShellExecution", transcript_path: "/x.jsonl" })).toBe("");
  });

  test("no transcript path is empty", () => {
    expect(cursorPrompt({ hook_event_name: "stop" })).toBe("");
  });
});
