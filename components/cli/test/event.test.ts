import { describe, expect, test } from "bun:test";
import * as ev from "../src/event";

describe("crops", () => {
  test("cropPrompt collapses whitespace to one line", () => {
    expect(ev.cropPrompt("  fix\nthe\t login   bug  ")).toBe("fix the login bug");
  });
  test("cropPrompt crops to 160 code points", () => {
    expect(Array.from(ev.cropPrompt("x".repeat(300))).length).toBe(160);
  });
  test("cropPrompt keeps multi-byte characters intact at the boundary", () => {
    const s = "é".repeat(200);
    const out = ev.cropPrompt(s);
    expect(Array.from(out).length).toBe(160);
    expect(out).toBe("é".repeat(160));
  });
  test("cropReply crops to 280", () => {
    expect(Array.from(ev.cropReply("y".repeat(500))).length).toBe(280);
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

describe("validate", () => {
  const valid = (): ev.Event => ({
    v: 1, id: "x", ts: "2026-07-07T10:00:00Z", host: "h", agent: "claude",
    event: "done", session_key: "claude:1",
  });
  test("accepts a valid event", () => expect(ev.validate(valid())).toBeNull());
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
