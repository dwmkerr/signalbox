import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scanClaudeHooks is not exported; exercise the observable behaviour instead
// by driving runSetup with a fake HOME and capturing stdout. Lighter: just
// assert the classification via a settings fixture through the public runSetup
// output. We check the three cases: ours, wrapper (other), empty.

function runInstallInHome(settings: object | null, args: string[]): { out: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "sbhome-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (settings) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  const out = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "install", "--yes", ...args],
    { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" }
  );
  return { out: out.stdout.toString() + out.stderr.toString(), home };
}

function runInstall(settings: object | null, args: string[]): string {
  return runInstallInHome(settings, args).out;
}

function readSettings(home: string): any {
  return JSON.parse(require("node:fs").readFileSync(join(home, ".claude", "settings.json"), "utf8"));
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
    const out = runInstall(hookBlock("signalbox hook claude"), ["--agent", "claude"]);
    expect(out).toContain("✔ Claude Code");
    expect(out).not.toContain("merge the JSON block");
  });

  test("a wrapper script reads as present, never asks to merge", () => {
    const out = runInstall(hookBlock("~/.claude/hooks/agent-notify.sh"), ["--agent", "claude"]);
    expect(out).toContain("hooks present via a wrapper");
    expect(out).not.toContain("merge the JSON block");
  });

  test("no hooks merges them in, with a backup", () => {
    const out = runInstall({}, ["--agent", "claude"]);
    expect(out).toContain("\u2714 Claude Code");
    expect(out).toContain("(backup: ");
  });

  test("a fresh install wires the two ask hooks", () => {
    const { home } = runInstallInHome({}, ["--agent", "claude"]);
    const s = readSettings(home);
    const cmd = (e: any) => e.hooks[0].command;
    expect(cmd(s.hooks.PermissionRequest[0])).toBe("signalbox hook claude");
    const ask = s.hooks.PreToolUse.find((e: any) => e.matcher === "AskUserQuestion");
    expect(cmd(ask)).toBe("signalbox hook claude");
  });

  test("an old signalbox setup gains the new ask hooks on re-run", () => {
    // Classic events already route to signalbox, but the ask hooks predate
    // this feature - install must add them, not report done.
    const { out, home } = runInstallInHome(hookBlock("signalbox hook claude"), ["--agent", "claude"]);
    expect(out).toContain("\u2714 Claude Code");
    const s = readSettings(home);
    expect(s.hooks.PermissionRequest?.[0]?.hooks?.[0]?.command).toBe("signalbox hook claude");
    expect(s.hooks.PreToolUse?.some((e: any) => e.matcher === "AskUserQuestion")).toBe(true);
  });

  test("the AskUserQuestion hook coexists with a user's own PreToolUse matcher", () => {
    const settings = {
      ...hookBlock("signalbox hook claude"),
    } as any;
    settings.hooks.PreToolUse = [
      { matcher: "Edit", hooks: [{ type: "command", command: "prettier-hook.sh" }] },
    ];
    const { home } = runInstallInHome(settings, ["--agent", "claude"]);
    const s = readSettings(home);
    // The user's formatter survives untouched...
    expect(s.hooks.PreToolUse.some((e: any) => e.matcher === "Edit")).toBe(true);
    // ...and ours is appended, not merged into theirs.
    expect(s.hooks.PreToolUse.some((e: any) => e.matcher === "AskUserQuestion")).toBe(true);
  });

  test("re-running when already fully wired is idempotent (no duplicate ask hooks)", () => {
    const settings = { hooks: { ...hookBlock("signalbox hook claude").hooks } } as any;
    settings.hooks.PermissionRequest = [{ hooks: [{ type: "command", command: "signalbox hook claude" }] }];
    settings.hooks.PreToolUse = [
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "signalbox hook claude" }] },
    ];
    const { out, home } = runInstallInHome(settings, ["--agent", "claude"]);
    expect(out).toContain("\u2714 Claude Code");
    const s = readSettings(home);
    expect(s.hooks.PreToolUse.length).toBe(1);
    expect(s.hooks.PermissionRequest.length).toBe(1);
  });

  test("a wrapper setup is not given direct ask hooks (cannot verify, may double-fire)", () => {
    const { out, home } = runInstallInHome(hookBlock("~/.claude/hooks/agent-notify.sh"), ["--agent", "claude"]);
    expect(out).toContain("hooks present via a wrapper");
    const s = readSettings(home);
    expect(s.hooks.PermissionRequest).toBeUndefined();
    expect(s.hooks.PreToolUse).toBeUndefined();
  });
});

describe("install scope flags", () => {
  test("--agent claude runs only the agents group", () => {
    const out = runInstall(hookBlock("signalbox hook claude"), ["--agent", "claude"]);
    expect(out).toContain("Claude Code");
    expect(out).not.toContain("tmux integration");
    expect(out).not.toContain("Menu bar app");
  });

  test("--app runs only the app group", () => {
    const out = runInstall(null, ["--app"]);
    expect(out).toContain("Menu bar app");
    expect(out).not.toContain("Claude Code");
  });

  test("unknown agent errors", () => {
    const out = runInstall(null, ["--agent", "nosuchagent"]);
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
