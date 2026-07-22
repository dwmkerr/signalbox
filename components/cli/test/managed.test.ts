import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeManagedBlock, removeManagedBlock, hasManagedBlock, managedBlock,
  mergeHookCommand, removeHookCommand, mergeCursorHooks, removeCursorHooks,
  detectCodexHooksOwner, MANAGED_BEGIN, MANAGED_END,
} from "../src/managed";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sb-managed-"));
}

describe("managed text block", () => {
  test("adds a fenced block to an existing file, keeping its content", () => {
    const f = join(tmp(), ".tmux.conf");
    writeFileSync(f, "set -g mouse on\n");
    const r = writeManagedBlock(f, "set -g status-interval 2");
    expect(r.changed).toBe(true);
    const out = readFileSync(f, "utf8");
    expect(out).toContain("set -g mouse on");
    expect(out).toContain(MANAGED_BEGIN);
    expect(out).toContain(MANAGED_END);
    expect(out).toContain("set -g status-interval 2");
  });

  test("re-running with the same body is a no-op (idempotent)", () => {
    const f = join(tmp(), ".tmux.conf");
    writeFileSync(f, "set -g mouse on\n");
    writeManagedBlock(f, "line-a");
    const r2 = writeManagedBlock(f, "line-a");
    expect(r2.changed).toBe(false);
    // exactly one managed region
    const out = readFileSync(f, "utf8");
    expect(out.split(MANAGED_BEGIN).length - 1).toBe(1);
  });

  test("a changed body replaces the region in place, not append", () => {
    const f = join(tmp(), ".tmux.conf");
    writeManagedBlock(f, "old-line");
    writeManagedBlock(f, "new-line");
    const out = readFileSync(f, "utf8");
    expect(out).toContain("new-line");
    expect(out).not.toContain("old-line");
    expect(out.split(MANAGED_BEGIN).length - 1).toBe(1);
  });

  test("remove strips only the managed block and backs up", () => {
    const f = join(tmp(), ".tmux.conf");
    writeFileSync(f, "set -g mouse on\n");
    writeManagedBlock(f, "signalbox-line");
    const r = removeManagedBlock(f);
    expect(r.changed).toBe(true);
    const out = readFileSync(f, "utf8");
    expect(out).toContain("set -g mouse on");
    expect(hasManagedBlock(out)).toBe(false);
    expect(r.backup && existsSync(r.backup)).toBe(true);
  });

  test("managedBlock carries the edit/remove note", () => {
    expect(managedBlock("x")).toContain("signalbox init --reverse");
  });
});

describe("managed json hooks", () => {
  const CMD = "signalbox hook codex";
  const EVENTS = ["SessionStart", "Stop"];

  test("adds command to each event alongside existing hooks", () => {
    const f = join(tmp(), "hooks.json");
    writeFileSync(f, JSON.stringify({ hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "koi-thing" }] }] } }));
    const m = mergeHookCommand(f, EVENTS, CMD);
    expect(m.changed.sort()).toEqual(["SessionStart", "Stop"]);
    m.write();
    const doc = JSON.parse(readFileSync(f, "utf8"));
    // koi entry preserved, signalbox added
    const cmds = doc.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds).toContain("koi-thing");
    expect(cmds).toContain(CMD);
    expect(doc.hooks.Stop[0].hooks[0].command).toBe(CMD);
  });

  test("re-merge is idempotent (already-present events skipped)", () => {
    const f = join(tmp(), "hooks.json");
    writeFileSync(f, "{}");
    mergeHookCommand(f, EVENTS, CMD).write();
    const again = mergeHookCommand(f, EVENTS, CMD);
    expect(again.changed).toEqual([]);
  });

  test("remove strips signalbox hooks, keeps others, drops empty events", () => {
    const f = join(tmp(), "hooks.json");
    writeFileSync(f, JSON.stringify({ hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "koi-thing" }] }] } }));
    mergeHookCommand(f, EVENTS, CMD).write();
    const r = removeHookCommand(f, CMD);
    expect(r.changed).toBe(true);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    // koi survives, Stop (only signalbox) is gone
    expect(doc.hooks.SessionStart[0].hooks[0].command).toBe("koi-thing");
    expect(doc.hooks.Stop).toBeUndefined();
  });
});

describe("cursor hooks (flat format)", () => {
  const CMD = "signalbox hook cursor";
  test("merges into the flat {version, hooks:{event:[{command}]}} shape", () => {
    const f = join(tmp(), "hooks.json");
    const m = mergeCursorHooks(f, ["sessionStart", "stop"], CMD);
    expect(m.changed).toEqual(["sessionStart", "stop"]);
    m.write();
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(doc.version).toBe(1);
    expect(doc.hooks.sessionStart).toEqual([{ command: CMD }]);
  });
  test("preserves the user's own cursor hooks and is idempotent", () => {
    const f = join(tmp(), "hooks.json");
    writeFileSync(f, JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "my-own" }] } }));
    mergeCursorHooks(f, ["sessionStart"], CMD).write();
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(doc.hooks.sessionStart.map((h: any) => h.command)).toEqual(["my-own", CMD]);
    expect(mergeCursorHooks(f, ["sessionStart"], CMD).changed).toEqual([]);
  });
  test("remove strips only signalbox and drops empty events", () => {
    const f = join(tmp(), "hooks.json");
    writeFileSync(f, JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "my-own" }] } }));
    mergeCursorHooks(f, ["sessionStart", "stop"], CMD).write();
    expect(removeCursorHooks(f, CMD).changed).toBe(true);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(doc.hooks.sessionStart).toEqual([{ command: "my-own" }]);
    expect(doc.hooks.stop).toBeUndefined();
  });
});

describe("detectCodexHooksOwner", () => {
  test("koi-managed comment is detected", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, "[hooks.state.'x']  # koi-managed\ntrusted_hash = \"sha256:abc\"\n");
    expect(detectCodexHooksOwner(f)).toBe("koi");
  });
  test("trust-hash entries without koi read as another tool", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, "[hooks.state.'y']\ntrusted_hash = \"sha256:abc\"\n");
    expect(detectCodexHooksOwner(f)).toBe("another tool");
  });
  test("plain config has no external owner", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, "model = \"gpt-5\"\n");
    expect(detectCodexHooksOwner(f)).toBeNull();
  });
});
