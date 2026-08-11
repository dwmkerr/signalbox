import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("native iTerm jump", () => {
  test("raises the recorded iTerm session before marking it seen", () => {
    const dir = mkdtempSync(join(tmpdir(), "signalbox-iterm-jump-test-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);

    const lsappinfo = join(bin, "lsappinfo");
    writeFileSync(lsappinfo, "#!/bin/sh\nprintf 'ASN:0x0-0x0: iTerm2\\n'\n");
    chmodSync(lsappinfo, 0o755);

    const osascript = join(bin, "osascript");
    writeFileSync(
      osascript,
      [
        "#!/bin/sh",
        "script=$(sed -n '1,240p')",
        "if [ \"$1\" = \"-\" ] && [ \"$2\" = \"id\" ] && [ \"$3\" = \"SESSION-GUID\" ] && printf '%s' \"$script\" | grep -q 'id of s is targetValue'; then",
        "  printf 'raised\\n'",
        "  exit 0",
        "fi",
        "printf 'not-found\\n'",
        "exit 1",
        "",
      ].join("\n")
    );
    chmodSync(osascript, 0o755);

    const jumpSource = join(import.meta.dir, "..", "src", "jump.ts");
    const script = `
      import { jumpTo } from ${JSON.stringify(jumpSource)};
      await jumpTo("http://127.0.0.1:1", {
        v: 1,
        id: "event-id",
        ts: "2026-08-11T10:00:00Z",
        host: "mac",
        agent: "codex",
        event: "done",
        session_key: "codex:iterm",
        origin: { kind: "iterm", iterm: { session: "SESSION-GUID" } },
      });
    `;
    const proc = Bun.spawnSync([process.execPath, "-e", script], {
      env: {
        ...process.env,
        HOME: dir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SIGNALBOX_DATA_DIR: dir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
    const seen = JSON.parse(readFileSync(join(dir, "spool.jsonl"), "utf8").trim());
    expect(seen.event).toBe("seen");
    expect(seen.session_key).toBe("codex:iterm");
  });
});
