import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TRANSCRIPT_WINDOW_BYTES,
  TURN_TEXT_MAX_BYTES,
  discoverTranscripts,
  parseTurns,
  type TranscriptAgent,
  type TranscriptFile,
  type Turn,
} from "../src/transcripts";

const fixtures = join(import.meta.dir, "testdata", "transcripts");
const claudeUuid = "11111111-1111-4111-8111-111111111111";
const codexUuid = "22222222-2222-4222-8222-222222222222";
const cursorUuid = "33333333-3333-4333-8333-333333333333";

const claudeFixture = join(fixtures, "claude", `${claudeUuid}.jsonl`);
const codexFixture = join(fixtures, "codex", `rollout-2026-08-19T09-30-00-${codexUuid}.jsonl`);
const cursorFixture = join(fixtures, "cursor", cursorUuid, `${cursorUuid}.jsonl`);

describe("parseTurns fixtures", () => {
  test("Claude includes displayed turns and skips every noise shape", () => {
    const result = parseTurns(claudeFixture, "claude", 0);
    expect(result).toEqual({
      turns: [
        { role: "user", text: "Fix the transcript parser", ts: "2026-08-19T09:00:00.000Z" },
        { role: "assistant", text: "I will inspect it. Then add tests.", ts: "2026-08-19T09:00:01.000Z" },
      ],
      endOffset: readFileSync(claudeFixture).byteLength,
      cwd: "/work/claude-project",
      sessionUuid: claudeUuid,
    });
  });

  test("Codex includes only event messages and never response items", () => {
    const result = parseTurns(codexFixture, "codex", 0);
    expect(result).toEqual({
      turns: [
        { role: "user", text: "Implement bounded parsing", ts: "2026-08-19T09:30:01.000Z" },
        { role: "assistant", text: "The parser is bounded.", ts: "2026-08-19T09:30:03.000Z" },
      ],
      endOffset: readFileSync(codexFixture).byteLength,
      cwd: "/work/codex-project",
      sessionUuid: codexUuid,
    });
  });

  test("Cursor trusts only the top-level role and skips non-text blocks", () => {
    const result = parseTurns(cursorFixture, "cursor", 0);
    expect(result).toEqual({
      turns: [
        { role: "user", text: "Search these sessions", ts: "2026-08-19T10:00:00.000Z" },
        { role: "assistant", text: "I found two. Here they are.", ts: "2026-08-19T10:00:01.000Z" },
      ],
      endOffset: readFileSync(cursorFixture).byteLength,
      cwd: "/work/cursor-project",
      sessionUuid: cursorUuid,
    });
  });
});

interface IncrementalCase {
  agent: TranscriptAgent;
  filename: string;
  prefix: unknown[];
  first: unknown;
  second: unknown;
  expected: Turn[];
}

const incrementalCases: IncrementalCase[] = [
  {
    agent: "claude",
    filename: "44444444-4444-4444-8444-444444444444.jsonl",
    prefix: [{ type: "system", cwd: "/work/claude", message: { content: "noise" } }],
    first: { type: "user", cwd: "/work/claude", message: { role: "user", content: "first" } },
    second: { type: "assistant", cwd: "/work/claude", message: { role: "assistant", content: "second" } },
    expected: [{ role: "user", text: "first" }, { role: "assistant", text: "second" }],
  },
  {
    agent: "codex",
    filename: "rollout-2026-08-19T11-00-00-55555555-5555-4555-8555-555555555555.jsonl",
    prefix: [{ type: "session_meta", payload: { session_id: "55555555-5555-4555-8555-555555555555", cwd: "/work/codex" } }],
    first: { type: "event_msg", payload: { type: "user_message", message: "first" } },
    second: { type: "event_msg", payload: { type: "agent_message", message: "second" } },
    expected: [{ role: "user", text: "first" }, { role: "assistant", text: "second" }],
  },
  {
    agent: "cursor",
    filename: "66666666-6666-4666-8666-666666666666.jsonl",
    prefix: [{ role: "system", cwd: "/work/cursor", message: { content: "noise" } }],
    first: { role: "user", cwd: "/work/cursor", message: { content: "first" } },
    second: { role: "assistant", cwd: "/work/cursor", message: { content: "second" } },
    expected: [{ role: "user", text: "first" }, { role: "assistant", text: "second" }],
  },
];

describe("partial-line resume", () => {
  for (const item of incrementalCases) {
    test(`${item.agent} leaves a partial final line and resumes it exactly once`, () => {
      const dir = mkdtempSync(join(tmpdir(), `sb-${item.agent}-partial-`));
      const path = join(dir, item.filename);
      const completed = [...item.prefix, item.first].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      const finalLine = JSON.stringify(item.second);
      const split = Math.floor(finalLine.length / 2);
      writeFileSync(path, completed + finalLine.slice(0, split));

      const first = parseTurns(path, item.agent, 0);
      expect(first.turns).toEqual([item.expected[0]]);
      expect(first.endOffset).toBe(Buffer.byteLength(completed));
      expect(first.endOffset).toBeLessThan(readFileSync(path).byteLength);
      expect(readFileSync(path).byteLength - first.endOffset).toBeLessThan(TRANSCRIPT_WINDOW_BYTES);

      const waiting = parseTurns(path, item.agent, first.endOffset);
      expect(waiting.turns).toEqual([]);
      expect(waiting.endOffset).toBe(first.endOffset);

      appendFileSync(path, finalLine.slice(split) + "\n");
      const resumed = parseTurns(path, item.agent, first.endOffset);
      expect(resumed.turns).toEqual([item.expected[1]]);
      expect(resumed.endOffset).toBe(readFileSync(path).byteLength);
      expect([...first.turns, ...resumed.turns]).toEqual(item.expected);
    });
  }
});

describe("bounded parsing", () => {
  test("skips an oversized line across bounded calls and parses later turns", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sb-transcript-oversized-")), `${claudeUuid}.jsonl`);
    const skipped = JSON.stringify({
      type: "user",
      message: { role: "user", content: "must be skipped" },
    });
    const oversized = " ".repeat(TRANSCRIPT_WINDOW_BYTES * 2) + skipped;
    const user = JSON.stringify({ type: "user", message: { role: "user", content: "after oversized" } });
    const assistant = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "still parsed" },
    });
    writeFileSync(path, `${oversized}\n${user}\n${assistant}\n`);

    const turns: Turn[] = [];
    const fileSize = readFileSync(path).byteLength;
    let offset = 0;
    let calls = 0;
    while (offset < fileSize) {
      expect(calls++).toBeLessThan(10);
      const result = parseTurns(path, "claude", offset);
      expect(result.endOffset).toBeGreaterThan(offset);
      turns.push(...result.turns);
      offset = result.endOffset;
    }

    expect(calls).toBeGreaterThan(2);
    expect(offset).toBe(fileSize);
    expect(turns).toEqual([
      { role: "user", text: "after oversized" },
      { role: "assistant", text: "still parsed" },
    ]);
  });

  test("one invocation does not read a whole multi-megabyte transcript", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sb-transcript-window-")), `${claudeUuid}.jsonl`);
    const first = JSON.stringify({ type: "user", message: { role: "user", content: "first" } });
    const filler = JSON.stringify({ type: "system", payload: "x".repeat(500) });
    const last = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "last" } });
    writeFileSync(path, `${first}\n${Array(5000).fill(filler).join("\n")}\n${last}\n`);

    const result = parseTurns(path, "claude", 0);
    expect(result.turns).toEqual([{ role: "user", text: "first" }]);
    expect(result.endOffset).toBeGreaterThan(0);
    expect(result.endOffset).toBeLessThan(readFileSync(path).byteLength);
  });

  test("caps one turn by UTF-8 bytes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sb-transcript-cap-")),
      "rollout-2026-08-19T12-00-00-77777777-7777-4777-8777-777777777777.jsonl");
    const message = "x".repeat(TURN_TEXT_MAX_BYTES + 100);
    writeFileSync(path, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } }) + "\n");

    const result = parseTurns(path, "codex", 0);
    expect(result.turns).toHaveLength(1);
    expect(Buffer.byteLength(result.turns[0].text, "utf8")).toBe(TURN_TEXT_MAX_BYTES);
  });
});

describe("discoverTranscripts", () => {
  const rootVariables = [
    "SIGNALBOX_CLAUDE_TRANSCRIPTS_DIR",
    "SIGNALBOX_CODEX_TRANSCRIPTS_DIR",
    "SIGNALBOX_CURSOR_TRANSCRIPTS_DIR",
  ] as const;

  function withRoots(roots: [string, string, string], run: () => void): void {
    const previous = rootVariables.map((name) => process.env[name]);
    rootVariables.forEach((name, index) => { process.env[name] = roots[index]; });
    try {
      run();
    } finally {
      rootVariables.forEach((name, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  }

  test("enumerates all three overridden corpus roots", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-transcript-discovery-"));
    const claudeRoot = join(root, "claude-projects");
    const codexRoot = join(root, "codex-sessions");
    const cursorRoot = join(root, "cursor-projects");
    const claudePath = join(claudeRoot, "-work-claude", `${claudeUuid}.jsonl`);
    const codexPath = join(codexRoot, "2026", "08", "19", `rollout-2026-08-19T09-30-00-${codexUuid}.jsonl`);
    const cursorPath = join(cursorRoot, "work-cursor", "agent-transcripts", cursorUuid, `${cursorUuid}.jsonl`);
    for (const path of [claudePath, codexPath, cursorPath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    writeFileSync(join(claudeRoot, "-work-claude", "not-jsonl.txt"), "");
    mkdirSync(join(cursorRoot, "work-cursor", "agent-transcripts", "wrong"), { recursive: true });
    writeFileSync(join(cursorRoot, "work-cursor", "agent-transcripts", "wrong", "different.jsonl"), "");

    withRoots([claudeRoot, codexRoot, cursorRoot], () => {
      const expected: TranscriptFile[] = [
        { path: claudePath, agent: "claude", sessionUuid: claudeUuid },
        { path: codexPath, agent: "codex", sessionUuid: codexUuid },
        { path: cursorPath, agent: "cursor", sessionUuid: cursorUuid },
      ];
      expect(discoverTranscripts()).toEqual(expected.sort((a, b) => a.path.localeCompare(b.path)));
    });
  });

  test("recurses through Claude subagents and attributes them to the parent session", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-claude-nested-discovery-"));
    const claudeRoot = join(root, "claude-projects");
    const projectDir = join(claudeRoot, "-work-claude");
    const parentUuid = "88888888-8888-4888-8888-888888888888";
    const topLevelPath = join(projectDir, `${claudeUuid}.jsonl`);
    const subagentPath = join(projectDir, parentUuid, "subagents", "agent-x.jsonl");
    const workflowPath = join(
      projectDir,
      parentUuid,
      "subagents",
      "workflows",
      "wf_y",
      "agent-z.jsonl",
    );
    const memoryPath = join(projectDir, "memory", "notes.jsonl");
    const tooDeepPath = join(
      projectDir,
      parentUuid,
      ...Array.from({ length: 20 }, (_, index) => `nested-${index}`),
      "agent-too-deep.jsonl",
    );
    for (const path of [topLevelPath, subagentPath, workflowPath, memoryPath, tooDeepPath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }

    withRoots([claudeRoot, join(root, "codex"), join(root, "cursor")], () => {
      const expected: TranscriptFile[] = [
        { path: topLevelPath, agent: "claude", sessionUuid: claudeUuid },
        { path: subagentPath, agent: "claude", sessionUuid: parentUuid },
        { path: workflowPath, agent: "claude", sessionUuid: parentUuid },
      ];
      expect(discoverTranscripts()).toEqual(expected.sort((a, b) => a.path.localeCompare(b.path)));
      expect(parseTurns(subagentPath, "claude", 0).sessionUuid).toBe(parentUuid);
      expect(parseTurns(workflowPath, "claude", 0).sessionUuid).toBe(parentUuid);
    });
  });

  test("missing corpus roots are normal", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-transcript-missing-"));
    withRoots([join(root, "claude"), join(root, "codex"), join(root, "cursor")], () => {
      expect(discoverTranscripts()).toEqual([]);
    });
  });
});
