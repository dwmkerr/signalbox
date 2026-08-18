import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ev from "../src/event";

describe("crops", () => {
  test("cropText keeps newlines and markdown intact", () => {
    expect(ev.cropText("# Heading\n\n- one\n- two", ev.PromptMax)).toEqual({
      text: "# Heading\n\n- one\n- two",
      cropped: false,
    });
  });
  test("cropText trims surrounding whitespace only", () => {
    expect(ev.cropText("  hi\nthere  ", ev.PromptMax)).toEqual({
      text: "hi\nthere",
      cropped: false,
    });
  });
  test("cropPrompt crops to 1024 code points and flags it", () => {
    const out = ev.cropPrompt("x".repeat(2000));
    expect(Array.from(out.text).length).toBe(1024);
    expect(out.cropped).toBe(true);
  });
  test("cropReply crops to 10240 code points and flags it", () => {
    const out = ev.cropReply("y".repeat(20000));
    expect(Array.from(out.text).length).toBe(10240);
    expect(out.cropped).toBe(true);
  });
  test("cropReply honours an explicit cap", () => {
    const out = ev.cropReply("y".repeat(50), 10);
    expect(Array.from(out.text).length).toBe(10);
    expect(out.cropped).toBe(true);
  });
  test("cropReply keeps multi-byte characters intact at the boundary", () => {
    const cap = 10;
    const out = ev.cropReply("😀".repeat(20), cap);
    expect(Array.from(out.text).length).toBe(cap);
    expect(Array.from(out.text).some((point) => point.length === 1 && /[\uD800-\uDFFF]/.test(point))).toBe(false);
  });
  test("cropTitle collapses whitespace to one line", () => {
    expect(ev.cropTitle("  fix\nthe\t login   bug  ")).toBe("fix the login bug");
  });
  test("cropLabel crops to 80", () => {
    expect(Array.from(ev.cropLabel("z".repeat(200))).length).toBe(80);
  });
});

describe("user events", () => {
  test("newSeen takes agent from the key convention", () => {
    const e = ev.newSeen("claude:abc");
    expect(e.event).toBe("seen");
    expect(e.agent).toBe("claude");
    expect(e.session_key).toBe("claude:abc");
    expect(e.v).toBe(1);
    expect(e.id).not.toBe("");
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(e.machine).toBeTruthy();
  });
  test("newSeen falls back to user agent without the convention", () => {
    expect(ev.newSeen("nocolon").agent).toBe("user");
  });
  test("newHide", () => {
    expect(ev.newHide("pi:1").event).toBe("hide");
  });
  test("newShow / newPin / newUnpin build user events from the key convention", () => {
    expect(ev.newShow("claude:abc").event).toBe("show");
    expect(ev.newPin("claude:abc").event).toBe("pin");
    expect(ev.newUnpin("pi:1").event).toBe("unpin");
    const pin = ev.newPin("claude:abc");
    expect(pin.agent).toBe("claude");
    expect(pin.session_key).toBe("claude:abc");
  });
  test("newLabel collapses and crops", () => {
    const e = ev.newLabel("claude:abc", "  prod\ndeploy  ");
    expect(e.event).toBe("label");
    expect(e.label).toBe("prod deploy");
  });
  test("newEnded carries the reason", () => {
    const e = ev.newEnded("claude:abc", "removed");
    expect(e.event).toBe("ended");
    expect(e.reason).toBe("removed");
  });
});

describe("machine identity", () => {
  test("machineID creates and caches a stable id", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-machine-"));
    const id = ev.machineID(dir);
    expect(id).toMatch(/^.+-[0-9a-f]{6}$/);
    expect(id.startsWith(`${ev.shortHostname()}-`)).toBe(true);
    expect(readFileSync(join(dir, "machine-id"), "utf8").trim()).toBe(id);
    expect(ev.machineID(dir)).toBe(id);
  });

  test("machineID reads a pre-seeded id", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-machine-seeded-"));
    writeFileSync(join(dir, "machine-id"), "seeded-machine-id\n");
    expect(ev.machineID(dir)).toBe("seeded-machine-id");
  });

  test("concurrent creators all keep the first published id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-machine-race-"));
    const workers = 4;
    const eventSrc = join(import.meta.dir, "..", "src", "event.ts");
    const processes = Array.from({ length: workers }, (_, index) => {
      const ready = join(dir, `${index}.ready`);
      const script = `
        import { readdirSync, writeFileSync } from "node:fs";
        import { machineID } from ${JSON.stringify(eventSrc)};
        const original = crypto.getRandomValues.bind(crypto);
        crypto.getRandomValues = (bytes) => {
          writeFileSync(${JSON.stringify(ready)}, "");
          while (readdirSync(${JSON.stringify(dir)}).filter((name) => name.endsWith(".ready")).length < ${workers}) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
          original(bytes);
          bytes.fill(${index + 1});
          return bytes;
        };
        process.stdout.write(machineID(${JSON.stringify(dir)}));
      `;
      return Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    });

    const results = await Promise.all(processes.map(async (proc) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return stdout;
    }));

    expect(new Set(results).size).toBe(1);
    expect(readFileSync(join(dir, "machine-id"), "utf8").trim()).toBe(results[0]);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("validate", () => {
  const valid = (): ev.Event => ({
    v: 1, id: "x", ts: "2026-07-07T10:00:00Z", host: "h", agent: "claude",
    event: "done", session_key: "claude:1",
  });
  test("accepts a valid event without machine", () => expect(ev.validate(valid())).toBeNull());
  test("rejects wrong version", () => {
    expect(ev.validate({ ...valid(), v: 2 })).toContain("v must be");
  });
  test("rejects unknown event type", () => {
    expect(ev.validate({ ...valid(), event: "nope" })).toContain("unknown event type");
  });
  test("rejects missing session_key", () => {
    expect(ev.validate({ ...valid(), session_key: "" })).toContain("session_key");
  });
  test("rejects origin with both tmux and url", () => {
    const e = { ...valid(), origin: { tmux: { session: "s", window: 1, pane: "%1" }, url: "https://x" } };
    expect(ev.validate(e)).toContain("union");
  });
  test("rejects empty origin", () => {
    expect(ev.validate({ ...valid(), origin: {} })).toContain("empty");
  });
  test("accepts label as a valid type", () => {
    expect(ev.validate({ ...valid(), event: "label" })).toBeNull();
  });
  test("accepts show, pin, and unpin as valid types", () => {
    expect(ev.validate({ ...valid(), event: "show" })).toBeNull();
    expect(ev.validate({ ...valid(), event: "pin" })).toBeNull();
    expect(ev.validate({ ...valid(), event: "unpin" })).toBeNull();
  });
});

describe("redact", () => {
  test("drops cropped", async () => {
    const e: ev.Event = {
      v: 1, id: "x", ts: "t", host: "h", agent: "claude", event: "done",
      session_key: "claude:secret-session-id", prompt: "prompt", reply: "reply", cropped: true,
    };
    await ev.redact(e);
    expect(e.cropped).toBeUndefined();
  });

  test("drops naming fields and hashes the session id", async () => {
    const e: ev.Event = {
      v: 1, id: "x", ts: "t", host: "h", agent: "claude", event: "done",
      session_key: "claude:secret-session-id",
      cwd: "/home/dave/corp/secret", title: "secret", prompt: "names the work", reply: "also names it",
    };
    await ev.redact(e);
    expect(e.cwd).toBeUndefined();
    expect(e.title).toBeUndefined();
    expect(e.prompt).toBeUndefined();
    expect(e.reply).toBeUndefined();
    expect(e.session_key).not.toBe("claude:secret-session-id");
    expect(e.session_key.startsWith("claude:")).toBe(true);
    expect(e.session_key.length).toBe("claude:".length + 12);
  });
});

describe("agentFamily", () => {
  test("bare agents pass through unchanged", () => {
    expect(ev.agentFamily("claude")).toBe("claude");
    expect(ev.agentFamily("cursor")).toBe("cursor");
    expect(ev.agentFamily("opencode")).toBe("opencode");
  });
  test("host-prefixed display names strip to the family", () => {
    expect(ev.agentFamily("vscode/claude")).toBe("claude");
    expect(ev.agentFamily("cursor/claude")).toBe("claude");
  });
});

describe("wire format", () => {
  test("JSON round-trips a tmux origin", () => {
    const e = ev.newSeen("claude:abc");
    e.origin = { tmux: { session: "dwmkerr", window: 4, pane: "%12", socket: "/tmp/tmux/x", terminal: "com.googlecode.iterm2" } };
    const back = JSON.parse(JSON.stringify(e));
    expect(back.origin.tmux.pane).toBe("%12");
    expect(back.origin.tmux.socket).toBe("/tmp/tmux/x");
    expect(back.origin.url).toBeUndefined();
  });
  test("optional fields are omitted when absent", () => {
    const raw = JSON.stringify(ev.newSeen("claude:abc"));
    expect(raw).not.toContain('"detail"');
    expect(raw).not.toContain('"origin"');
    expect(raw).not.toContain('"acked"');
    expect(raw).not.toContain('"label"');
  });
});

describe("normalizeInbound (legacy migration)", () => {
  test("backfills an absent machine from host", () => {
    const e: ev.Event = { v: 1, id: "x", ts: "t", host: "h", agent: "claude", event: "done", session_key: "claude:1" };
    ev.normalizeInbound(e);
    expect(e.machine).toBe("h");
  });
  test("keeps an existing machine", () => {
    const e: ev.Event = { v: 1, id: "x", ts: "t", host: "h", machine: "h-abc123", agent: "claude", event: "done", session_key: "claude:1" };
    ev.normalizeInbound(e);
    expect(e.machine).toBe("h-abc123");
  });
  test("detail becomes prompt when prompt absent", () => {
    const e: any = { v: 1, id: "x", ts: "t", host: "h", agent: "claude", event: "done", session_key: "claude:1", detail: "old field" };
    ev.normalizeInbound(e);
    expect(e.prompt).toBe("old field");
    expect(e.detail).toBeUndefined();
  });
  test("prompt wins when both present", () => {
    const e: any = { v: 1, id: "x", ts: "t", host: "h", agent: "claude", event: "done", session_key: "claude:1", detail: "old", prompt: "new" };
    ev.normalizeInbound(e);
    expect(e.prompt).toBe("new");
    expect(e.detail).toBeUndefined();
  });
  test("origin.kind inferred from the set field", () => {
    const tmux: ev.Event = { v: 1, id: "x", ts: "t", host: "h", agent: "claude", event: "done", session_key: "claude:1", origin: { tmux: { session: "s", window: 1, pane: "%1" } } };
    ev.normalizeInbound(tmux);
    expect(tmux.origin?.kind).toBe("tmux");
    const url: ev.Event = { v: 1, id: "x", ts: "t", host: "h", agent: "github", event: "done", session_key: "github:1", origin: { url: "https://x" } };
    ev.normalizeInbound(url);
    expect(url.origin?.kind).toBe("url");
  });
});
