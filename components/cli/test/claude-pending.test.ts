// Contract tests for what the Claude Code transcript contains at the moment a
// prompt is blocking - the facts that decide whether the adapter can enrich
// attention events with the actual ask (the board today shows only the bare
// "Claude needs your permission" notification message).
//
// Fixtures are sanitized captures of a real session (Claude Code v2.1.218,
// 2026-07-23), snapshotted via shellwright WHILE each dialog was pending and
// unanswered. Entry order and block structure are faithful; prompts, paths,
// and attachment payloads are scrubbed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Block = { type: string; id?: string; tool_use_id?: string; name?: string; input?: Record<string, unknown> };
type Entry = { type: string; message?: { content?: Block[] | string } };

function entries(name: string): Entry[] {
  const path = join(import.meta.dir, "testdata", name);
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

// A pending tool call is a tool_use block whose id has no matching
// tool_result - the correlation an enrichment feature would rely on.
function pendingToolUses(all: Entry[]): Block[] {
  const uses: Block[] = [];
  const resolved = new Set<string>();
  for (const e of all) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use" && b.id) uses.push(b);
      if (b.type === "tool_result" && b.tool_use_id) resolved.add(b.tool_use_id);
    }
  }
  return uses.filter((u) => !resolved.has(u.id!));
}

describe("claude transcript at prompt time", () => {
  test("permission prompt: the pending tool_use is already flushed, with its full input", () => {
    const all = entries("claude-transcript-permission-pending.jsonl");
    const pending = pendingToolUses(all);
    expect(pending.length).toBe(1);
    expect(pending[0].name).toBe("Bash");
    expect(pending[0].input?.command).toBe("touch test-file.txt");
    expect(pending[0].input?.description).toBe("Create empty test-file.txt");
  });

  test("resolved tool calls are not pending (AskUserQuestion answered earlier in the session)", () => {
    const all = entries("claude-transcript-permission-pending.jsonl");
    const answered = all.flatMap((e) =>
      Array.isArray(e.message?.content) ? e.message.content : []
    ).filter((b) => b.type === "tool_use" && b.name === "AskUserQuestion");
    expect(answered.length).toBe(1);
    expect(pendingToolUses(all).some((b) => b.name === "AskUserQuestion")).toBe(false);
  });

  // Canary: Claude Code buffers the assistant message while AskUserQuestion
  // waits - the transcript holds NO assistant entry at all, so the question
  // text cannot be recovered from disk at notification time. If this test
  // ever fails, Claude Code started flushing before the dialog and the
  // adapter can enrich question notifications the same way as permissions.
  test("question prompt: the AskUserQuestion tool_use is NOT in the transcript while pending", () => {
    const all = entries("claude-transcript-question-pending.jsonl");
    expect(all.some((e) => e.type === "assistant")).toBe(false);
    expect(pendingToolUses(all).length).toBe(0);
  });
});
