import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOpenURL } from "../src/jump";

describe("checkOpenURL", () => {
  test("allows web schemes", () => {
    expect(checkOpenURL("https://github.com/x/y")).toBeNull();
    expect(checkOpenURL("http://localhost:3000")).toBeNull();
  });
  test("refuses everything that could execute", () => {
    expect(checkOpenURL("file:///etc/passwd")).toContain("refusing");
    expect(checkOpenURL("x-apple.systempreferences:")).toContain("refusing");
    expect(checkOpenURL("javascript:alert(1)")).toContain("refusing");
    expect(checkOpenURL("-a Calculator")).toContain("flag");
    expect(checkOpenURL("not a url")).toContain("refusing");
  });
});

function shim(bin: string, name: string, lines: string[]): void {
  writeFileSync(join(bin, name), ["#!/bin/sh", ...lines].join("\n") + "\n");
  chmodSync(join(bin, name), 0o755);
}

// Runs jumpTo in a child with lsappinfo, osascript and open faked on PATH. The
// fakes report which apps run and which tty each terminal holds, and log every
// script as "<app> <tty>" and every activation as "open <bundle>". The hub is
// unreachable, so the auto-ack lands in the spool.
function jumpWith(running: string[], held: { iterm?: string; terminal?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "signalbox-jump-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  shim(bin, "lsappinfo", ['case " $FAKE_RUNNING " in *" ${2#bundleid=} "*) echo "ASN:0x0-0x1:" ;; esac']);
  shim(bin, "osascript", [
    'case "$(cat)" in *\'"iTerm2"\'*) app=iterm want="$FAKE_ITERM" ;; *) app=terminal want="$FAKE_TERMINAL" ;; esac',
    'echo "$app $2" >> "$FAKE_LOG"',
    '[ "$2" = "$want" ] && echo raised || echo not-found',
  ]);
  shim(bin, "open", ['echo "open $2" >> "$FAKE_LOG"']);
  const event = {
    v: 1, id: "e", ts: "2026-10-15T10:00:00Z", host: "mac", agent: "claude", event: "done",
    session_key: "claude:tty", origin: { kind: "tty", tty: { path: "/dev/ttys004" } },
  };
  const jump = join(import.meta.dir, "..", "src", "jump.ts");
  const p = Bun.spawnSync(
    [process.execPath, "-e", `import { jumpTo } from ${JSON.stringify(jump)}; await jumpTo("http://127.0.0.1:1", ${JSON.stringify(event)});`],
    {
      env: {
        ...process.env, HOME: dir, SIGNALBOX_DATA_DIR: dir, PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_RUNNING: running.join(" "), FAKE_ITERM: held.iterm ?? "", FAKE_TERMINAL: held.terminal ?? "", FAKE_LOG: log,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const spool = join(dir, "spool.jsonl");
  return {
    code: p.exitCode,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    seen: existsSync(spool) ? JSON.parse(readFileSync(spool, "utf8").trim()) : null,
  };
}

const iTerm = "com.googlecode.iterm2";
const terminal = "com.apple.Terminal";

describe("tty jump", () => {
  test("selects the iTerm session holding the tty, then marks it seen", () => {
    const r = jumpWith([iTerm], { iterm: "/dev/ttys004" });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["iterm /dev/ttys004"]);
    expect(r.seen).toMatchObject({ event: "seen", session_key: "claude:tty" });
  });

  test("selects the Terminal tab and activates Terminal, never probing an iTerm that is not running", () => {
    const r = jumpWith([terminal], { terminal: "/dev/ttys004" });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["terminal /dev/ttys004", "open com.apple.Terminal"]);
    expect(r.seen).toMatchObject({ event: "seen", session_key: "claude:tty" });
  });

  test("fails without marking seen when no tab holds the tty", () => {
    const r = jumpWith([iTerm, terminal], {});
    expect(r.code).not.toBe(0);
    expect(r.calls).toEqual(["iterm /dev/ttys004", "terminal /dev/ttys004"]);
    expect(r.seen).toBeNull();
  });
});
