import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Event } from "./event";
import { openIndex, type SearchIndex } from "./searchindex";

const rootVariables = [
  "SIGNALBOX_CLAUDE_TRANSCRIPTS_DIR",
  "SIGNALBOX_CODEX_TRANSCRIPTS_DIR",
  "SIGNALBOX_CURSOR_TRANSCRIPTS_DIR",
] as const;

const claudeUuid = "11111111-1111-4111-8111-111111111111";
const codexUuid = "22222222-2222-4222-8222-222222222222";
const cursorUuid = "33333333-3333-4333-8333-333333333333";

interface Corpus {
  indexDir: string;
  claudeRoot: string;
  codexRoot: string;
  cursorRoot: string;
  claudePath: string;
  codexPath: string;
  cursorPath: string;
}

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createCorpus(): Corpus {
  const root = mkdtempSync(join(tmpdir(), "signalbox-searchquery-"));
  const claudeRoot = join(root, "claude-projects");
  const codexRoot = join(root, "codex-sessions");
  const cursorRoot = join(root, "cursor-projects");
  const claudePath = join(claudeRoot, "-work-claude", `${claudeUuid}.jsonl`);
  const codexPath = join(
    codexRoot,
    "2026",
    "08",
    "19",
    `rollout-2026-08-19T10-00-00-${codexUuid}.jsonl`,
  );
  const cursorPath = join(
    cursorRoot,
    "work-cursor",
    "agent-transcripts",
    cursorUuid,
    `${cursorUuid}.jsonl`,
  );

  write(claudePath, jsonl([
    {
      type: "user",
      cwd: "/work/claude",
      timestamp: "2026-08-19T09:00:00.000Z",
      message: { role: "user", content: "editor editor editor integration" },
    },
    {
      type: "assistant",
      cwd: "/work/claude",
      timestamp: "2026-08-19T09:01:00.000Z",
      message: { role: "assistant", content: "editor integration ready or pending" },
    },
  ]));
  write(codexPath, jsonl([
    { type: "session_meta", payload: { session_id: codexUuid, cwd: "/work/codex" } },
    {
      type: "event_msg",
      timestamp: "2026-08-19T10:00:00.000Z",
      payload: { type: "user_message", message: "editor docs are near release" },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-19T10:01:00.000Z",
      payload: { type: "agent_message", message: "shared needle" },
    },
  ]));
  write(cursorPath, jsonl([
    {
      role: "user",
      cwd: "/work/cursor",
      timestamp: "2026-08-19T12:00:00.000Z",
      message: { content: "editing cursor settings" },
    },
    {
      role: "assistant",
      cwd: "/work/cursor",
      timestamp: "2026-08-19T12:01:00.000Z",
      message: { content: "shared needle" },
    },
  ]));

  return {
    indexDir: join(root, "state"),
    claudeRoot,
    codexRoot,
    cursorRoot,
    claudePath,
    codexPath,
    cursorPath,
  };
}

function withIndex(run: (index: SearchIndex, corpus: Corpus) => void): void {
  const previous = rootVariables.map((name) => process.env[name]);
  const corpus = createCorpus();
  const roots = [corpus.claudeRoot, corpus.codexRoot, corpus.cursorRoot];
  rootVariables.forEach((name, index) => { process.env[name] = roots[index]; });
  const index = openIndex(corpus.indexDir);
  try {
    expect(index.sweep({ budgetMs: 5_000 })).toEqual({
      filesScanned: 3,
      filesUpdated: 3,
      turnsAdded: 6,
      workRemains: false,
    });
    run(index, corpus);
  } finally {
    index.close();
    rootVariables.forEach((name, variableIndex) => {
      const value = previous[variableIndex];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
}

function liveSession(sessionKey: string, transcript: string): Event {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: "2026-08-19T12:30:00.000Z",
    host: "test",
    agent: "codex",
    event: "done",
    session_key: sessionKey,
    transcript,
  };
}

describe("countHits", () => {
  test("counts prefix-matching turns rather than occurrences or sessions", () => withIndex((index) => {
    expect(index.countHits("edit")).toBe(4);
    expect(index.countHits("editor integration")).toBe(2);
  }));
});

describe("search", () => {
  test("groups by session and selects the best FTS5 snippet", () => withIndex((index) => {
    const results = index.search("edit", 10);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      sessionUuid: claudeUuid,
      agent: "claude",
      cwd: "/work/claude",
      snippet: "<mark>editor</mark> <mark>editor</mark> <mark>editor</mark> integration",
      ts: "2026-08-19T09:00:00.000Z",
      hitCount: 2,
      state: "ended",
      sessionKey: null,
    });
  }));

  test("uses matching-turn recency to break equal relevance", () => withIndex((index) => {
    expect(index.search("needle", 10).map((result) => result.sessionUuid)).toEqual([
      cursorUuid,
      codexUuid,
    ]);
  }));

  test("applies the session limit after grouping", () => withIndex((index) => {
    expect(index.search("edit", 2)).toHaveLength(2);
    expect(index.search("edit", 0)).toEqual([]);
  }));

  test("resolves live rows by exact indexed transcript path", () => withIndex((index, corpus) => {
    const results = index.search("edit", 10, [liveSession("codex:live", corpus.codexPath)]);
    expect(results.find((result) => result.sessionUuid === codexUuid)).toMatchObject({
      state: "live",
      sessionKey: "codex:live",
    });
    expect(results.find((result) => result.sessionUuid === claudeUuid)).toMatchObject({
      state: "ended",
      sessionKey: null,
    });
  }));

  test("does not infer a live row from a session key when its path differs", () => withIndex((index) => {
    const results = index.search("edit", 10, [liveSession(codexUuid, "/not/the/transcript.jsonl")]);
    expect(results.find((result) => result.sessionUuid === codexUuid)).toMatchObject({
      state: "ended",
      sessionKey: null,
    });
  }));
});

describe("query sanitiser", () => {
  test("an unbalanced quote remains a plain prefix query", () => withIndex((index) => {
    expect(() => index.search('edit"', 10)).not.toThrow();
    expect(index.countHits('edit"')).toBe(4);
    expect(index.search('edit"', 10)).toHaveLength(3);
  }));

  test("a bare wildcard has no terms and no matches", () => withIndex((index) => {
    expect(() => index.search("*", 10)).not.toThrow();
    expect(index.countHits("*")).toBe(0);
    expect(index.search("*", 10)).toEqual([]);
  }));

  test("a stray NEAR parenthesis searches for NEAR as text", () => withIndex((index) => {
    expect(() => index.search("NEAR(", 10)).not.toThrow();
    expect(index.countHits("NEAR(")).toBe(1);
    expect(index.search("NEAR(", 10).map((result) => result.sessionUuid)).toEqual([codexUuid]);
  }));

  test("OR is quoted as a term instead of becoming an operator", () => withIndex((index) => {
    expect(() => index.search("OR", 10)).not.toThrow();
    expect(index.countHits("OR")).toBe(1);
    expect(index.search("OR", 10).map((result) => result.sessionUuid)).toEqual([claudeUuid]);
  }));

  test("a leading minus is discarded instead of becoming negation", () => withIndex((index) => {
    expect(() => index.search("-edit", 10)).not.toThrow();
    expect(index.countHits("-edit")).toBe(4);
    expect(index.search("-edit", 10)).toHaveLength(3);
  }));

  test("a lone caret has no terms and no matches", () => withIndex((index) => {
    expect(() => index.search("^", 10)).not.toThrow();
    expect(index.countHits("^")).toBe(0);
    expect(index.search("^", 10)).toEqual([]);
  }));

  test("an unbalanced parenthesis remains a plain prefix query", () => withIndex((index) => {
    expect(() => index.search("(edit", 10)).not.toThrow();
    expect(index.countHits("(edit")).toBe(4);
    expect(index.search("(edit", 10)).toHaveLength(3);
  }));
});
