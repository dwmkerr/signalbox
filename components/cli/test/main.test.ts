import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep CLI runs away from the developer's real persisted Signalbox settings.
const testHome = mkdtempSync(join(tmpdir(), "signalbox-main-test-"));

// Drive the compiled dispatch through the source entrypoint to prove the
// noun-verb grouping maps to the same handlers as the flat aliases.
function run(args: string[], env: Record<string, string> = {}): { out: string; code: number } {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...args], {
    env: { ...process.env, HOME: testHome, SIGNALBOX_URL: "http://127.0.0.1:1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: p.stdout.toString() + p.stderr.toString(), code: p.exitCode };
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
    run(args, { SIGNALBOX_STATE_DIR: dir });
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
