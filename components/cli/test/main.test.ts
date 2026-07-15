import { describe, expect, test } from "bun:test";

// Drive the compiled dispatch through the source entrypoint to prove the
// noun-verb grouping maps to the same handlers as the flat aliases.
function run(args: string[], env: Record<string, string> = {}): { out: string; code: number } {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...args], {
    env: { ...process.env, SIGNALBOX_URL: "http://127.0.0.1:1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: p.stdout.toString() + p.stderr.toString(), code: p.exitCode };
}
import { join } from "node:path";

describe("grouped command dispatch", () => {
  test("unknown subcommand under a noun lists valid verbs", () => {
    const { out, code } = run(["session", "bogus"]);
    expect(out).toContain("unknown subcommand");
    expect(out).toContain("ack, hide, rename, remove, list");
    expect(code).toBe(2);
  });

  test("session rename with no key logs usage, exits 0 (hook-safe)", () => {
    // Hook-path commands always exit 0; with a dead hub it just spools/logs.
    const { code } = run(["session", "rename"]);
    expect(code).toBe(0);
  });

  test("help lists the grouped commands", () => {
    const { out } = run(["help"]);
    expect(out).toContain("session ack");
    expect(out).toContain("tmux status");
    expect(out).toContain("hook claude");
  });

  test("unknown top-level command errors", () => {
    const { out, code } = run(["nonsense"]);
    expect(out).toContain("unknown command");
    expect(code).toBe(2);
  });
});
