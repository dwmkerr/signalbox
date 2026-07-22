import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scanClaudeHooks is not exported; exercise the observable behaviour instead
// by driving runSetup with a fake HOME and capturing stdout. Lighter: just
// assert the classification via a settings fixture through the public runSetup
// output. We check the three cases: ours, unrelated hook (other), empty.

function runInstall(settings: object | null, args: string[]): { out: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "sbhome-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (settings) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  const p = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "install", "--yes", ...args],
    { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" }
  );
  return { out: p.stdout.toString() + p.stderr.toString(), home };
}

const hookBlock = (cmd: string) => ({
  hooks: Object.fromEntries(
    ["Notification", "Stop", "UserPromptSubmit", "SessionStart", "SessionEnd"].map((e) => [
      e,
      [{ hooks: [{ type: "command", command: cmd }] }],
    ])
  ),
});

describe("install claude-hook detection", () => {
  test("direct signalbox command reads as done", () => {
    const { out } = runInstall(hookBlock("signalbox hook claude"), ["--agent", "claude"]);
    expect(out).toContain("✔ Claude Code");
    expect(out).not.toContain("merge the JSON block");
  });

  test("a command mentioning signalbox counts as wired - never doubled", () => {
    const { out, home } = runInstall(hookBlock("~/.claude/hooks/signalbox-dispatch.sh"), ["--agent", "claude"]);
    expect(out).not.toContain("merge the JSON block");
    const settings = JSON.parse(require("node:fs").readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const cmds = settings.hooks.Stop.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toEqual(["~/.claude/hooks/signalbox-dispatch.sh"]);
  });

  test("an unrelated hook gets signalbox appended alongside, untouched", () => {
    const { out, home } = runInstall(hookBlock("~/.claude/hooks/agent-notify.sh"), ["--agent", "claude"]);
    expect(out).toContain("✔ Claude Code");
    expect(out).toContain("(backup: ");
    const settings = JSON.parse(require("node:fs").readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    for (const ev of ["Notification", "Stop", "UserPromptSubmit", "SessionStart", "SessionEnd"]) {
      const cmds = settings.hooks[ev].flatMap((e: any) => e.hooks.map((h: any) => h.command));
      expect(cmds).toEqual(["~/.claude/hooks/agent-notify.sh", "signalbox hook claude"]);
    }
  });

  test("no hooks merges them in, with a backup", () => {
    const { out } = runInstall({}, ["--agent", "claude"]);
    expect(out).toContain("\u2714 Claude Code");
    expect(out).toContain("(backup: ");
  });
});

describe("install scope flags", () => {
  test("--agent claude runs only the agents group", () => {
    const { out } = runInstall(hookBlock("signalbox hook claude"), ["--agent", "claude"]);
    expect(out).toContain("Claude Code");
    expect(out).not.toContain("tmux integration");
    expect(out).not.toContain("Menu bar app");
  });

  test("--app runs only the app group", () => {
    const { out } = runInstall(null, ["--app"]);
    expect(out).toContain("Menu bar app");
    expect(out).not.toContain("Claude Code");
  });

  test("unknown agent errors", () => {
    const { out } = runInstall(null, ["--agent", "nosuchagent"]);
    expect(out).toContain("unknown agent");
  });
});

describe("init verbose", () => {
  function runInit(args: string[]): string {
    const home = mkdtempSync(join(tmpdir(), "sbinit-"));
    const out = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "init", ...args],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" }
    );
    return out.stdout.toString() + out.stderr.toString();
  }

  // `-v` renders the read-only status board with per-row paths (never the
  // picker). The VS Code row is always configured, so its path detail appears
  // only under `-v` - a stable marker that `-v` reached the verbose status view.
  const vscodePath = /no setup|once VS Code is installed/;

  test("init -v shows paths", () => {
    expect(runInit(["-v"])).toMatch(vscodePath);
  });

  test("init without -v omits paths", () => {
    expect(runInit([])).not.toMatch(vscodePath);
  });
});

describe("remove (init --remove)", () => {
  function runRemove(setup: () => string, args: string[]): string {
    const home = setup();
    const out = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "init", "--yes", "--remove", ...args],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" }
    );
    return out.stdout.toString() + out.stderr.toString();
  }

  test("--remove --agent pi unlinks the extension", () => {
    let dest = "";
    const out = runRemove(() => {
      const home = mkdtempSync(join(tmpdir(), "sbrm-"));
      dest = join(home, ".pi", "agent", "extensions", "signalbox.ts");
      mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
      writeFileSync(dest, "// stub");
      return home;
    }, ["--agent", "pi"]);
    expect(out).toContain("removed");
    expect(require("node:fs").existsSync(dest)).toBe(false);
  });

  test("--remove --tmux reverses signalbox's managed block, keeping the rest", () => {
    let conf = "";
    const out = runRemove(() => {
      const home = mkdtempSync(join(tmpdir(), "sbrm-"));
      conf = join(home, ".tmux.conf");
      writeFileSync(conf, "set -g mouse on\n# >>> signalbox managed >>>\nset -g x\n# <<< signalbox managed <<<\n");
      return home;
    }, ["--tmux"]);
    expect(out).toContain("removed signalbox block");
    const after = require("node:fs").readFileSync(conf, "utf8");
    expect(after).toContain("set -g mouse on");
    expect(after).not.toContain("signalbox managed");
  });

  test("--remove --tmux with no signalbox block says there is nothing to remove", () => {
    const out = runRemove(() => mkdtempSync(join(tmpdir(), "sbrm-")), ["--tmux"]);
    expect(out).toContain("no signalbox edit to remove");
  });
});
