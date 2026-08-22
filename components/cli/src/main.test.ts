import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "./searchindex";

// Keep CLI runs away from the developer's real persisted Signalbox settings.
const testHome = mkdtempSync(join(tmpdir(), "signalbox-main-test-"));

// Drive the compiled dispatch through the source entrypoint to prove the
// noun-verb grouping maps to the same handlers as the flat aliases.
function run(args: string[], env: Record<string, string> = {}): { out: string; code: number } {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "main.ts"), ...args], {
    env: { ...process.env, HOME: testHome, SIGNALBOX_URL: "http://127.0.0.1:1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: p.stdout.toString() + p.stderr.toString(), code: p.exitCode };
}

const searchRootVariables = [
  "SIGNALBOX_CLAUDE_TRANSCRIPTS_DIR",
  "SIGNALBOX_CODEX_TRANSCRIPTS_DIR",
  "SIGNALBOX_CURSOR_TRANSCRIPTS_DIR",
] as const;

function searchFixture(): { dataDir: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "signalbox-main-search-"));
  const dataDir = join(root, "state");
  const claudeRoot = join(root, "claude-projects");
  const codexRoot = join(root, "codex-sessions");
  const cursorRoot = join(root, "cursor-projects");
  const liveTranscript = join(
    claudeRoot,
    "-work-editor-live",
    "11111111-1111-4111-8111-111111111111.jsonl",
  );
  const endedTranscript = join(
    claudeRoot,
    "-work-editor-archive",
    "22222222-2222-4222-8222-222222222222.jsonl",
  );
  mkdirSync(join(claudeRoot, "-work-editor-live"), { recursive: true });
  mkdirSync(join(claudeRoot, "-work-editor-archive"), { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  mkdirSync(cursorRoot, { recursive: true });
  writeFileSync(liveTranscript, [
    JSON.stringify({
      type: "user",
      cwd: "/work/editor-live",
      timestamp: "2026-08-22T09:00:00.000Z",
      message: { role: "user", content: "editor editor session" },
    }),
    JSON.stringify({
      type: "assistant",
      cwd: "/work/editor-live",
      timestamp: "2026-08-22T09:01:00.000Z",
      message: { role: "assistant", content: "editor changes are ready" },
    }),
  ].join("\n") + "\n");
  writeFileSync(endedTranscript, [
    JSON.stringify({
      type: "user",
      cwd: "/work/editor-archive",
      timestamp: "2026-08-21T09:00:00.000Z",
      message: { role: "user", content: "editor archive session" },
    }),
    JSON.stringify({
      type: "assistant",
      cwd: "/work/editor-archive",
      timestamp: "2026-08-21T09:01:00.000Z",
      message: { role: "assistant", content: "archive complete" },
    }),
  ].join("\n") + "\n");

  const roots = [claudeRoot, codexRoot, cursorRoot];
  const previous = searchRootVariables.map((name) => process.env[name]);
  searchRootVariables.forEach((name, index) => { process.env[name] = roots[index]; });
  const index = openIndex(dataDir);
  try {
    expect(index.sweep({ budgetMs: 5_000 })).toMatchObject({
      filesScanned: 2,
      turnsAdded: 4,
      workRemains: false,
    });
  } finally {
    index.close();
    searchRootVariables.forEach((name, variableIndex) => {
      const value = previous[variableIndex];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }

  writeFileSync(join(dataDir, "events.jsonl"), JSON.stringify({
    v: 1,
    id: "search-live-session",
    ts: "2026-08-22T09:02:00.000Z",
    host: "test",
    agent: "claude",
    event: "done",
    session_key: "claude:live",
    cwd: "/work/editor-live",
    transcript: liveTranscript,
  }) + "\n");

  return {
    dataDir,
    env: {
      SIGNALBOX_SEARCH: "1",
      SIGNALBOX_DATA_DIR: dataDir,
      SIGNALBOX_CLAUDE_TRANSCRIPTS_DIR: claudeRoot,
      SIGNALBOX_CODEX_TRANSCRIPTS_DIR: codexRoot,
      SIGNALBOX_CURSOR_TRANSCRIPTS_DIR: cursorRoot,
      COLUMNS: "160",
    },
  };
}

describe("version provenance", () => {
  test("prints a bare semver when unstamped", () => {
    expect(run(["version"], { SIGNALBOX_BUILD: "" }).out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("prints the build stamp when stamped", () => {
    expect(run(["version"], { SIGNALBOX_BUILD: "abc1234-dirty" }).out.trim()).toMatch(
      / \(abc1234-dirty\)$/
    );
  });

  test("includes the build stamp in help", () => {
    expect(run(["help"], { SIGNALBOX_BUILD: "abc1234-dirty" }).out).toContain(
      "(abc1234-dirty)"
    );
  });
});

describe("grouped command dispatch", () => {
  test("unknown subcommand under a noun lists valid verbs", () => {
    const { out, code } = run(["session", "bogus"]);
    expect(out).toContain("unknown subcommand");
    expect(out).toContain("ack, hide, show, pin, unpin");
    expect(code).toBe(2);
  });

  test("session rename with no key logs usage, exits 0 (hook-safe)", () => {
    // Hook-path commands always exit 0; with a dead hub it just spools/logs.
    const { code } = run(["session", "rename"]);
    expect(code).toBe(0);
  });

  test("session show/pin/unpin with no key log usage, exit 0 (hook-safe)", () => {
    // Hook-path commands always exit 0; with a dead hub they just spool/log.
    expect(run(["session", "show"]).code).toBe(0);
    expect(run(["session", "pin"]).code).toBe(0);
    expect(run(["session", "unpin"]).code).toBe(0);
  });

  test("help lists the grouped commands", () => {
    const { out } = run(["help"]);
    expect(out).toContain("session ack");
    expect(out).toContain("session show");
    expect(out).toContain("session pin");
    expect(out).toContain("session unpin");
    expect(out).toContain("tmux status");
    expect(out).toContain("hook claude");
    expect(out).toContain("--remote");
    expect(out).toContain("SIGNALBOX_REMOTE");
  });

  test("hub --remote with no SIGNALBOX_TOKEN fails loudly", () => {
    const { out, code } = run(["hub", "--remote"], { SIGNALBOX_TOKEN: "" });
    expect(code).toBe(1);
    expect(out).toContain("SIGNALBOX_TOKEN");
  });

  test("hub --upstream refuses an explicit bind", () => {
    const { out, code } = run(["hub", "--upstream", "https://x.example", "--bind", "0.0.0.0"]);
    expect(code).toBe(1);
    expect(out).toContain("--bind");
  });

  test("hub --upstream refuses remote mode", () => {
    const { out, code } = run(
      ["hub", "--upstream", "https://x.example", "--remote"],
      { SIGNALBOX_TOKEN: "t" }
    );
    expect(code).toBe(1);
    expect(out).toContain("--upstream");
  });

  test("hub --upstream refuses plain http off loopback", () => {
    const { out, code } = run(["hub", "--upstream", "http://my-hub.fly.dev"]);
    expect(code).toBe(1);
    expect(out).toContain("hub.upstream");
  });

  test("help lists forwarder configuration", () => {
    const { out } = run(["help"]);
    expect(out).toContain("--upstream");
    expect(out).toContain("SIGNALBOX_UPSTREAM");
    expect(out).toContain("hub.upstream");
  });

  test("unknown top-level command errors", () => {
    const { out, code } = run(["nonsense"]);
    expect(out).toContain("unknown command");
    expect(code).toBe(2);
  });
});

describe("search command", () => {
  test("lists the command, limit, and feature toggle in help", () => {
    const { out } = run(["help"]);
    expect(out).toContain("search <query>");
    expect(out).toContain("--limit 1-50");
    expect(out).toContain("SIGNALBOX_SEARCH");
  });

  test("reports how to enable search without opening an empty index", () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "signalbox-main-search-off-")), "state");
    const { out, code } = run(
      ["search", "editor"],
      { SIGNALBOX_SEARCH: "0", SIGNALBOX_DATA_DIR: dataDir },
    );

    expect(code).toBe(0);
    expect(out).toContain("enable it in Signalbox Settings");
    expect(out).toContain("searchEnabled to true in ~/.config/signalbox/settings.json");
    expect(out).toContain("scripts can use SIGNALBOX_SEARCH=1");
    expect(existsSync(join(dataDir, "search.db"))).toBe(false);
  });

  test("prints grouped live and ended sessions without raw mark tags", () => {
    const fixture = searchFixture();
    const { out, code } = run(["search", "editor"], fixture.env);

    expect(code).toBe(0);
    expect(out).toContain("STATE    AGENT   CWD");
    expect(out).toMatch(/● live\s+claude\s+editor-live\s+2\s+/);
    expect(out).toMatch(/· ended\s+claude\s+editor-archive\s+1\s+/);
    expect(out).toContain("editor editor session");
    expect(out).not.toContain("/work/editor");
    expect(out).not.toContain("<mark>");
    expect(out).not.toContain("</mark>");
  });

  test("supports JSON and caps the accepted session limit at 50", () => {
    const fixture = searchFixture();
    const jsonRun = run(["search", "editor", "--json", "--limit", "1"], fixture.env);
    const body = JSON.parse(jsonRun.out);

    expect(jsonRun.code).toBe(0);
    expect(body).toMatchObject({ enabled: true, query: "editor" });
    expect(body.results).toHaveLength(1);
    expect(body.results[0].snippet).not.toContain("<mark>");

    const invalid = run(["search", "editor", "--limit", "51"], fixture.env);
    expect(invalid.code).toBe(1);
    expect(invalid.out).toContain("invalid --limit");
    expect(invalid.out).toContain("between 1 and 50");
  });
});

describe("index command", () => {
  test("lists both modes in help and in command usage", () => {
    const help = run(["help"]);
    expect(help.out).toContain("index");
    expect(help.out).toContain("--status|--rebuild");

    const usage = run(["index"]);
    expect(usage.code).toBe(2);
    expect(usage.out).toContain("signalbox index --status");
    expect(usage.out).toContain("signalbox index --rebuild");
  });

  test("uses the search settings guidance without opening an empty index", () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "signalbox-main-index-off-")), "state");
    const { out, code } = run(
      ["index", "--status"],
      { SIGNALBOX_SEARCH: "0", SIGNALBOX_DATA_DIR: dataDir },
    );

    expect(code).toBe(0);
    expect(out).toContain("enable it in Signalbox Settings");
    expect(out).toContain("searchEnabled to true in ~/.config/signalbox/settings.json");
    expect(existsSync(join(dataDir, "search.db"))).toBe(false);
  });

  test("prints every status field", () => {
    const fixture = searchFixture();
    const { out, code } = run(["index", "--status"], fixture.env);

    expect(code).toBe(0);
    expect(out).toMatch(/files known: 2/);
    expect(out).toMatch(/files pending: 0/);
    expect(out).toMatch(/turns indexed: 4/);
    expect(out).toMatch(/last sweep time: \d{4}-\d{2}-\d{2}T/);
    expect(out).toContain("first build in progress: false");
    expect(out).toMatch(/index size: \d+(?:\.\d)? [KM]?i?B/);
  });

  test("rebuilds from scratch and reports accumulating progress", () => {
    const fixture = searchFixture();
    const { out, code } = run(["index", "--rebuild"], fixture.env);

    expect(code).toBe(0);
    expect(out).toContain("rebuilding search index...");
    expect(out).toContain("indexing: 0 turns from 0 files, 2 pending");
    expect(out).toContain("indexing: 4 turns from 2 files, 0 pending");
    expect(out).toMatch(/search index rebuilt: 4 turns from 2 files \(.+\)/);
  });
});

describe("fire usage errors", () => {
  test("an unknown --event warns on stderr and still exits 0 (hook-safe)", () => {
    const { out, code } = run(["fire", "--agent", "script", "--event", "needs_you"]);
    expect(code).toBe(0);
    expect(out).toContain("valid events");
    expect(out).toContain("attention");
  });
});

describe("fire tags", () => {
  function spooledEvents(args: string[]): Record<string, unknown>[] {
    const dir = mkdtempSync(join(tmpdir(), "signalbox-fire-tags-test-"));
    run(args, { SIGNALBOX_DATA_DIR: dir });
    return readFileSync(join(dir, "spool.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  test("writes the session event followed by one event carrying every tag", () => {
    const events = spooledEvents([
      "fire", "--agent", "script", "--event", "busy",
      "--session-key", "script:t3", "--tag", "alpha", "--tag", "beta",
    ]);

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("busy");
    expect(events[1].event).toBe("tag");
    expect(events[1].tags).toEqual(["alpha", "beta"]);
    expect(events[1].session_key).toBe(events[0].session_key);
  });

  test("writes no tag event when no tag is provided", () => {
    const events = spooledEvents([
      "fire", "--agent", "script", "--event", "busy", "--session-key", "script:t3",
    ]);

    expect(events).toHaveLength(1);
  });

  test("deduplicates tags and drops empty values", () => {
    const events = spooledEvents([
      "fire", "--agent", "script", "--event", "busy", "--session-key", "script:t3",
      "--tag", "alpha", "--tag", "alpha", "--tag", "",
    ]);

    expect(events).toHaveLength(2);
    expect(events[1].tags).toEqual(["alpha"]);
  });

  test("help lists the repeatable tag flag", () => {
    expect(run(["help"]).out).toContain("--tag");
  });
});
