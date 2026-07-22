import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, isLoopbackHost, isLoopbackAddress, validateBindConfig } from "../src/hub";
import { lanIPv4 } from "../src/pair";
import * as ev from "../src/event";
import type { Event } from "../src/event";

// A fake Bun server: hub.handle calls timeout() and requestIP() on it. The
// default peer is loopback, so every existing test drives the v0 path (no
// token, loopback-Host check) exactly as before. serverFrom() varies the peer.
function serverFrom(address: string): Bun.Server<undefined> {
  return {
    timeout() {},
    requestIP: () => ({ address, family: "IPv4", port: 54321 }),
  } as unknown as Bun.Server<undefined>;
}
const fakeServer = serverFrom("127.0.0.1");

function newHub(): { hub: Hub; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sbhub-"));
  const hub = new Hub(dir, "test");
  return { hub, dir };
}

function wireEvent(key: string, eventType: string, extra: Partial<Event> = {}): Event {
  return {
    v: 1, id: crypto.randomUUID(), ts: ev.nowTS(), host: "h", agent: "script",
    event: eventType, session_key: key, ...extra,
  };
}

async function post(hub: Hub, e: unknown, contentType = "application/json"): Promise<Response> {
  const req = new Request("http://127.0.0.1:8377/events", {
    method: "POST",
    headers: { "Content-Type": contentType, Host: "127.0.0.1:8377" },
    body: JSON.stringify(e),
  });
  return (await hub.handle(req, fakeServer))!;
}

function wireCommand(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, id: crypto.randomUUID(), ts: ev.nowTS(), command: "jump",
    session_key: key, target_host: "h", host: "phone", ...extra,
  };
}

async function postCommand(hub: Hub, c: unknown, contentType = "application/json"): Promise<Response> {
  const req = new Request("http://127.0.0.1:8377/command", {
    method: "POST",
    headers: { "Content-Type": contentType, Host: "127.0.0.1:8377" },
    body: JSON.stringify(c),
  });
  return (await hub.handle(req, fakeServer))!;
}

// Opens a live stream and returns its reader. Commands are only ever delivered
// to a connected subscriber, so a command test needs one open first.
async function openStream(hub: Hub, since: number) {
  const req = new Request(`http://127.0.0.1:8377/stream?since=${since}`, {
    headers: { Host: "localhost" },
  });
  const res = (await hub.handle(req, fakeServer))!;
  return { reader: res.body!.getReader(), dec: new TextDecoder() };
}

async function getState(hub: Hub): Promise<{ sessions: Event[] }> {
  const req = new Request("http://127.0.0.1:8377/state", { headers: { Host: "127.0.0.1:8377" } });
  const res = (await hub.handle(req, fakeServer))!;
  return res.json();
}

let hubs: Hub[] = [];
afterEach(() => {
  for (const h of hubs) h.close();
  hubs = [];
});

function track(h: Hub): Hub {
  hubs.push(h);
  return h;
}

describe("ingest and state", () => {
  test("POST assigns monotonic seq; /state orders by engagement", async () => {
    const { hub } = newHub();
    track(hub);
    const r1 = await post(hub, wireEvent("a", ev.Busy));
    const r2 = await post(hub, wireEvent("b", ev.Busy));
    expect((await r1.json()).seq).toBe(1);
    expect((await r2.json()).seq).toBe(2);
    const doc = await getState(hub);
    expect(doc.sessions.map((s) => s.session_key)).toEqual(["b", "a"]);
    expect(doc.sessions[0].engaged_ts).toBeTruthy();
  });

  test("ended removes from state", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Done));
    await post(hub, wireEvent("a", ev.Ended));
    expect((await getState(hub)).sessions.length).toBe(0);
  });

  test("seen acks and detail carries over HTTP", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Busy, { prompt: "the prompt" }));
    await post(hub, wireEvent("a", ev.Done));
    await post(hub, ev.newSeen("a"));
    const doc = await getState(hub);
    expect(doc.sessions[0].acked).toBe(true);
    expect(doc.sessions[0].prompt).toBe("the prompt");
  });

  test("hide serializes hidden", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Done));
    await post(hub, ev.newHide("a"));
    expect((await getState(hub)).sessions[0].hidden).toBe(true);
  });

  test("label round-trips over HTTP", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Done));
    await post(hub, ev.newLabel("a", "my name"));
    expect((await getState(hub)).sessions[0].label).toBe("my name");
  });

  test("POST strips client-supplied acked/hidden/pinned/engaged_ts", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Done, { acked: true, hidden: true, pinned: true, engaged_ts: "2030-01-01T00:00:00Z" }));
    const row = (await getState(hub)).sessions[0];
    expect(row.acked).toBeUndefined();
    expect(row.hidden).toBeUndefined();
    expect(row.pinned).toBeUndefined();
    expect(row.engaged_ts).not.toBe("2030-01-01T00:00:00Z");
  });

  test("pin serializes pinned and floats the row; unpin clears it", async () => {
    const { hub } = newHub();
    track(hub);
    // b engaged more recently than a, so b leads before any pin.
    await post(hub, wireEvent("a", ev.Busy, { ts: "2026-07-07T10:00:00Z" }));
    await post(hub, wireEvent("b", ev.Busy, { ts: "2026-07-07T10:05:00Z" }));
    expect((await getState(hub)).sessions.map((s) => s.session_key)).toEqual(["b", "a"]);
    await post(hub, ev.newPin("a"));
    let doc = await getState(hub);
    expect(doc.sessions.map((s) => s.session_key)).toEqual(["a", "b"]);
    expect(doc.sessions[0].pinned).toBe(true);
    expect(doc.sessions[1].pinned).toBeUndefined(); // false is omitted
    await post(hub, ev.newUnpin("a"));
    doc = await getState(hub);
    expect(doc.sessions.map((s) => s.session_key)).toEqual(["b", "a"]);
    expect(doc.sessions.find((s) => s.session_key === "a")?.pinned).toBeUndefined();
  });

  test("show unhides over HTTP", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Done));
    await post(hub, ev.newHide("a"));
    expect((await getState(hub)).sessions[0].hidden).toBe(true);
    await post(hub, ev.newShow("a"));
    expect((await getState(hub)).sessions[0].hidden).toBeUndefined();
  });

  test("hide drops a pin over HTTP", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Done));
    await post(hub, ev.newPin("a"));
    await post(hub, ev.newHide("a"));
    const row = (await getState(hub)).sessions[0];
    expect(row.pinned).toBeUndefined();
    expect(row.hidden).toBe(true);
  });
});

describe("validation and hardening", () => {
  test("rejects invalid events with 400", async () => {
    const { hub } = newHub();
    track(hub);
    const res = await post(hub, { v: 1, event: "done" });
    expect(res.status).toBe(400);
  });

  test("rejects wrong content type with 415", async () => {
    const { hub } = newHub();
    track(hub);
    const res = await post(hub, wireEvent("a", ev.Done), "text/plain");
    expect(res.status).toBe(415);
  });

  test("rejects non-loopback Host with 403", async () => {
    const { hub } = newHub();
    track(hub);
    const req = new Request("http://127.0.0.1:8377/state", { headers: { Host: "evil.example.com" } });
    const res = (await hub.handle(req, fakeServer))!;
    expect(res.status).toBe(403);
  });

  test("isLoopbackHost", () => {
    expect(isLoopbackHost("127.0.0.1:8377")).toBe(true);
    expect(isLoopbackHost("localhost:8377")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]:8377")).toBe(true);
    expect(isLoopbackHost("evil.example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.5:8377")).toBe(false);
  });

  test("stream rejects bad since with 400", async () => {
    const { hub } = newHub();
    track(hub);
    const req = new Request("http://127.0.0.1:8377/stream?since=abc", { headers: { Host: "localhost" } });
    const res = (await hub.handle(req, fakeServer))!;
    expect(res.status).toBe(400);
  });

  test("healthz reports version", async () => {
    const { hub } = newHub();
    track(hub);
    const req = new Request("http://127.0.0.1:8377/healthz", { headers: { Host: "localhost" } });
    const res = (await hub.handle(req, fakeServer))!;
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe("test");
  });
});

// A non-loopback peer and a helper to build requests from it. Auth is decided
// by the peer address (serverFrom below), never the Host header - so these
// requests deliberately carry a non-loopback Host to prove the loopback-Host
// rebinding check is skipped once the bearer has proved the caller.
const TOKEN = "s3cret-token-123";
const lan = serverFrom("192.168.1.50");

function lanReq(path: string, init: { bearer?: string; method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { Host: "192.168.1.50:8390" };
  if (init.bearer !== undefined) headers.Authorization = `Bearer ${init.bearer}`;
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  return new Request(`http://192.168.1.50:8390${path}`, { method: init.method ?? "GET", headers, body });
}

function tokenHub(token = TOKEN): Hub {
  const dir = mkdtempSync(join(tmpdir(), "sbhub-"));
  return track(new Hub(dir, "test", token));
}

describe("bind and bearer auth", () => {
  test("loopback peer, no token configured: serves exactly as today", async () => {
    // The most important regression guard: the default deployment path is
    // unchanged - loopback peer, no token, loopback Host.
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Busy));
    const res = (await hub.handle(
      new Request("http://127.0.0.1:8377/state", { headers: { Host: "127.0.0.1:8377" } }),
      fakeServer
    ))!;
    expect(res.status).toBe(200);
    expect((await res.json()).sessions.length).toBe(1);
  });

  test("non-loopback peer with the correct bearer reaches every route", async () => {
    const hub = tokenHub();
    const state = (await hub.handle(lanReq("/state", { bearer: TOKEN }), lan))!;
    expect(state.status).toBe(200);

    const events = (await hub.handle(
      lanReq("/events", { bearer: TOKEN, method: "POST", body: wireEvent("a", ev.Busy) }),
      lan
    ))!;
    expect(events.status).toBe(200);
    expect((await events.json()).seq).toBe(1);

    const command = (await hub.handle(
      lanReq("/command", { bearer: TOKEN, method: "POST", body: wireCommand("a") }),
      lan
    ))!;
    expect(command.status).toBe(200);

    const stream = (await hub.handle(lanReq("/stream?since=0", { bearer: TOKEN }), lan))!;
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body!.getReader().cancel();
  });

  test("non-loopback peer with no bearer is 401 with WWW-Authenticate", async () => {
    const hub = tokenHub();
    const res = (await hub.handle(lanReq("/state"), lan))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("non-loopback peer with the wrong bearer is 401", async () => {
    const hub = tokenHub();
    const res = (await hub.handle(lanReq("/state", { bearer: "not-the-token" }), lan))!;
    expect(res.status).toBe(401);
  });

  test("constant-time compare: wrong-length and equal-length wrong tokens both 401", async () => {
    const hub = tokenHub("abcdefgh");
    const wrongLength = (await hub.handle(lanReq("/state", { bearer: "xyz" }), lan))!;
    expect(wrongLength.status).toBe(401);
    const equalLength = (await hub.handle(lanReq("/state", { bearer: "12345678" }), lan))!;
    expect(equalLength.status).toBe(401);
  });

  test("non-loopback peer reaches /healthz with no token", async () => {
    const hub = tokenHub();
    const res = (await hub.handle(lanReq("/healthz"), lan))!;
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("loopback peer with a non-loopback Host is still 403 (rebinding defence)", async () => {
    // A bearer must not buy a loopback peer past the rebinding check: loopback
    // peers are gated by Host, never by the token.
    const hub = tokenHub();
    const res = (await hub.handle(
      new Request("http://127.0.0.1:8377/state", {
        headers: { Host: "evil.example.com", Authorization: `Bearer ${TOKEN}` },
      }),
      fakeServer
    ))!;
    expect(res.status).toBe(403);
  });
});

describe("bind config", () => {
  test("loopback binds never require a token", () => {
    expect(validateBindConfig("127.0.0.1", "")).toBeNull();
    expect(validateBindConfig("localhost", "")).toBeNull();
    expect(validateBindConfig("::1", "")).toBeNull();
    expect(validateBindConfig("127.0.0.5", "")).toBeNull();
  });

  test("non-loopback bind with no token is refused, naming SIGNALBOX_TOKEN", () => {
    expect(validateBindConfig("0.0.0.0", "")).toContain("SIGNALBOX_TOKEN");
    expect(validateBindConfig("192.168.1.5", "")).toContain("SIGNALBOX_TOKEN");
  });

  test("non-loopback bind with a token is allowed", () => {
    expect(validateBindConfig("0.0.0.0", "tok")).toBeNull();
    expect(validateBindConfig("192.168.1.5", "tok")).toBeNull();
  });

  test("isLoopbackAddress covers the loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.5.5.5")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("persistence", () => {
  test("rebuild from events.jsonl continues seq", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbhub-"));
    const first = track(new Hub(dir, "test"));
    await post(first, wireEvent("a", ev.Busy, { prompt: "kept" }));
    await post(first, wireEvent("a", ev.Done));
    first.close();

    const second = track(new Hub(dir, "test"));
    const doc = await getState(second);
    expect(doc.sessions.length).toBe(1);
    expect(doc.sessions[0].event).toBe(ev.Done);
    expect(doc.sessions[0].prompt).toBe("kept");
    const res = await post(second, wireEvent("b", ev.Busy));
    expect((await res.json()).seq).toBe(3);
  });

  test("a pin survives rebuild from events.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbhub-"));
    const first = track(new Hub(dir, "test"));
    await post(first, wireEvent("a", ev.Busy));
    await post(first, wireEvent("b", ev.Busy));
    await post(first, ev.newPin("a"));
    // An agent event after the pin must not drop it - the reducer that replays
    // the log on boot is the same one that carried the pin here.
    await post(first, wireEvent("a", ev.Done));
    first.close();

    const second = track(new Hub(dir, "test"));
    const doc = await getState(second);
    expect(doc.sessions.find((s) => s.session_key === "a")?.pinned).toBe(true);
    expect(doc.sessions[0].session_key).toBe("a"); // still pinned-first
  });

  test("rebuild skips corrupt lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbhub-"));
    const line = JSON.stringify({ ...wireEvent("a", ev.Done), seq: 1 });
    writeFileSync(join(dir, "events.jsonl"), `${line}\n{corrupt\n`);
    const hub = track(new Hub(dir, "test"));
    expect((await getState(hub)).sessions.length).toBe(1);
  });
});

describe("stream", () => {
  test("replays since then delivers live", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Busy));
    await post(hub, wireEvent("b", ev.Busy));

    const req = new Request("http://127.0.0.1:8377/stream?since=1", { headers: { Host: "localhost" } });
    const res = (await hub.handle(req, fakeServer))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    // Replay: only seq 2 (b).
    let text = dec.decode((await reader.read()).value);
    expect(text).toContain('"session_key":"b"');
    expect(text).not.toContain('"session_key":"a"');

    // Live: a new event arrives on the open stream.
    await post(hub, wireEvent("c", ev.Done));
    text = dec.decode((await reader.read()).value);
    expect(text).toContain('"session_key":"c"');
    await reader.cancel();
  });
});

// A command is a request to a machine, not a fact about a session. Every test
// here guards one half of that: it must reach a listener now, and it must
// leave no trace that could re-deliver it later. A replayed jump moves a
// window hours after the tap, which is why the log must never see one.
describe("commands", () => {
  test("jump reaches a live subscriber on its own frame", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("claude:x", ev.Busy));

    const { reader, dec } = await openStream(hub, 99);
    const res = await postCommand(hub, wireCommand("claude:x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: 1 });

    const text = dec.decode((await reader.read()).value);
    expect(text).toContain("event: command");
    expect(text).toContain('"command":"jump"');
    expect(text).toContain('"session_key":"claude:x"');
    await reader.cancel();
  });

  test("a since far ahead of every seq still delivers a command", async () => {
    // The regression this guards: commands have no seq, so routing them
    // through the event subscriber's replay gate would read them as seq 0 and
    // silently drop every one against any since > 0.
    const { hub } = newHub();
    track(hub);
    const { reader, dec } = await openStream(hub, 1000);
    await postCommand(hub, wireCommand("claude:x"));
    expect(dec.decode((await reader.read()).value)).toContain('"command":"jump"');
    await reader.cancel();
  });

  test("a command carries no event field, so an old client cannot decode it", async () => {
    // Load-bearing, and the reason the field is `command` and not `event`:
    // the Swift app decodes `event` as a required field inside a try?, so a
    // command is inert to a client that predates commands. Named `event` it
    // would instead reach the app's default branch and replace a row.
    const { hub } = newHub();
    track(hub);
    const { reader, dec } = await openStream(hub, 0);
    await postCommand(hub, wireCommand("claude:x"));
    const frame = dec.decode((await reader.read()).value);
    const payload = JSON.parse(frame.split("data: ")[1]);
    expect(payload.event).toBeUndefined();
    expect(payload.seq).toBeUndefined();
    await reader.cancel();
  });

  test("jump is never persisted, so it can never be replayed", async () => {
    const { hub, dir } = newHub();
    track(hub);
    await post(hub, wireEvent("claude:x", ev.Busy));
    await postCommand(hub, wireCommand("claude:x"));

    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).not.toContain("jump");

    // A client reconnecting from scratch replays the whole log: no jump in it.
    const { reader, dec } = await openStream(hub, 0);
    const text = dec.decode((await reader.read()).value);
    expect(text).toContain('"event":"busy"');
    expect(text).not.toContain("jump");
    await reader.cancel();
  });

  test("jump consumes no seq, so the log stays contiguous", async () => {
    // A seq consumed but not persisted would be reused after a reboot (the hub
    // restarts seq from the highest persisted value), and the app's monotonic
    // guard would then silently drop that real event.
    const { hub } = newHub();
    track(hub);
    expect(await (await post(hub, wireEvent("claude:x", ev.Busy))).json()).toEqual({ seq: 1 });
    await postCommand(hub, wireCommand("claude:x"));
    expect(await (await post(hub, wireEvent("claude:x", ev.Done))).json()).toEqual({ seq: 2 });
  });

  test("jump does not touch session state", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("claude:x", ev.Busy));
    await postCommand(hub, wireCommand("claude:x"));
    const doc = await getState(hub);
    expect(doc.sessions).toHaveLength(1);
    expect(doc.sessions[0].event).toBe(ev.Busy);
  });

  test("a jump for a session the hub never saw is still delivered", async () => {
    // The hub does not adjudicate targets: whoever owns the session decides.
    // A phone may hold a row the hub has since expired.
    const { hub } = newHub();
    track(hub);
    await openStream(hub, 0);
    const res = await postCommand(hub, wireCommand("claude:ghost"));
    expect(await res.json()).toEqual({ ok: true, delivered: 1 });
  });

  test("delivered is 0 when no machine is listening", async () => {
    // How the phone says "nothing is listening" at once instead of waiting out
    // a timeout.
    const { hub } = newHub();
    track(hub);
    expect(await (await postCommand(hub, wireCommand("claude:x"))).json()).toEqual({
      ok: true,
      delivered: 0,
    });
  });

  test("jump is still not an event type", async () => {
    // The event allowlist must not gain a door the command path exists to avoid.
    const { hub } = newHub();
    track(hub);
    const res = await post(hub, wireEvent("claude:x", "jump"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("unknown event type");
  });

  test("commands are validated", async () => {
    const { hub } = newHub();
    track(hub);
    const bad = async (c: unknown, want: string) => {
      const res = await postCommand(hub, c);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(want);
    };
    await bad({ ...wireCommand("claude:x"), command: "rm -rf" }, "unknown command");
    await bad({ ...wireCommand("claude:x"), target_host: "" }, "target_host is required");
    await bad({ ...wireCommand("claude:x"), session_key: "" }, "session_key is required");
    await bad({ ...wireCommand("claude:x"), v: 2 }, "v must be 1");
  });

  test("a stream that closed stops receiving commands", async () => {
    const { hub } = newHub();
    track(hub);
    const { reader } = await openStream(hub, 0);
    await reader.cancel();
    expect(await (await postCommand(hub, wireCommand("claude:x"))).json()).toEqual({
      ok: true,
      delivered: 0,
    });
  });
});

// Pairing. A hub that can mint needs a token AND a non-loopback bind (a
// loopback bind means no phone could reach it), so pairHub sets both. Requests
// to /pair/new and /pair/status are loopback-only regardless of bearer, so they
// drive fakeServer (127.0.0.1); the LAN-peer guard tests drive `lan`.
function pairHub(token: string, bind: string): Hub {
  const dir = mkdtempSync(join(tmpdir(), "sbhub-"));
  return track(new Hub(dir, "test", token, bind));
}

function pairNewReq(body: unknown = {}, contentType = "application/json"): Request {
  return new Request("http://127.0.0.1:8377/pair/new", {
    method: "POST",
    headers: { "Content-Type": contentType, Host: "127.0.0.1:8377" },
    body: JSON.stringify(body),
  });
}

function pairReq(body: unknown, contentType = "application/json"): Request {
  return new Request("http://127.0.0.1:8377/pair", {
    method: "POST",
    headers: { "Content-Type": contentType, Host: "127.0.0.1:8377" },
    body: JSON.stringify(body),
  });
}

function pairStatusReq(): Request {
  return new Request("http://127.0.0.1:8377/pair/status", { headers: { Host: "127.0.0.1:8377" } });
}

describe("pairing", () => {
  test("mint from the hub machine returns a base64url code, expiry, and the bind", async () => {
    const hub = pairHub(TOKEN, "0.0.0.0");
    const res = (await hub.handle(pairNewReq(), fakeServer))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.code.length).toBe(22); // 16 bytes, base64url, unpadded
    expect(body.expires_in).toBe(180);
    expect(body.bind).toBe("0.0.0.0");
  });

  test("mint from a LAN peer is 403 even with a valid bearer", async () => {
    // Past the auth gate the bearer already proved this peer; the explicit
    // loopback guard is what still refuses a mint from another machine.
    const hub = pairHub(TOKEN, "0.0.0.0");
    const res = (await hub.handle(lanReq("/pair/new", { bearer: TOKEN, method: "POST", body: {} }), lan))!;
    expect(res.status).toBe(403);
  });

  test("mint with no token configured is 409", async () => {
    const hub = pairHub("", "0.0.0.0");
    const res = (await hub.handle(pairNewReq(), fakeServer))!;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("SIGNALBOX_TOKEN");
  });

  test("mint while bound to loopback is 409", async () => {
    const hub = pairHub(TOKEN, "127.0.0.1");
    const res = (await hub.handle(pairNewReq(), fakeServer))!;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("127.0.0.1");
  });

  test("mint requires application/json", async () => {
    const hub = pairHub(TOKEN, "0.0.0.0");
    const res = (await hub.handle(pairNewReq({}, "text/plain"), fakeServer))!;
    expect(res.status).toBe(415);
  });

  test("a valid code is redeemed once for the token", async () => {
    const hub = pairHub(TOKEN, "0.0.0.0");
    const mint = await (await hub.handle(pairNewReq(), fakeServer))!.json();
    const first = (await hub.handle(pairReq({ code: mint.code }), fakeServer))!;
    expect(first.status).toBe(200);
    expect((await first.json()).token).toBe(TOKEN);
    // Second redemption of the same code is refused - single use.
    const second = (await hub.handle(pairReq({ code: mint.code }), fakeServer))!;
    expect(second.status).toBe(401);
    expect((await second.json()).error).toBe("invalid or expired pairing code");
  });

  test("a wrong code is 401", async () => {
    const hub = pairHub(TOKEN, "0.0.0.0");
    await hub.handle(pairNewReq(), fakeServer);
    const res = (await hub.handle(pairReq({ code: "not-the-code" }), fakeServer))!;
    expect(res.status).toBe(401);
  });

  test("an expired code is 401", async () => {
    const hub = pairHub(TOKEN, "0.0.0.0");
    const mint = await (await hub.handle(pairNewReq(), fakeServer))!.json();
    // Force the slot into the past rather than wait out 180s. Behavioural: a
    // lapsed code must be refused exactly like a wrong one.
    (hub as unknown as { pairing: { expiresAt: number } }).pairing.expiresAt = Date.now() - 1;
    const res = (await hub.handle(pairReq({ code: mint.code }), fakeServer))!;
    expect(res.status).toBe(401);
  });

  test("a non-string code is 401, never 500", async () => {
    // A number into createHash().update would throw; the handler must fold that
    // into the uniform 401 rather than surface a 500 oracle.
    const hub = pairHub(TOKEN, "0.0.0.0");
    await hub.handle(pairNewReq(), fakeServer);
    const res = (await hub.handle(pairReq({ code: 123 }), fakeServer))!;
    expect(res.status).toBe(401);
  });

  test("redeem requires application/json", async () => {
    const hub = pairHub(TOKEN, "0.0.0.0");
    const res = (await hub.handle(pairReq({ code: "x" }, "text/plain"), fakeServer))!;
    expect(res.status).toBe(415);
  });

  test("status walks none -> pending -> redeemed", async () => {
    const hub = pairHub(TOKEN, "0.0.0.0");
    expect((await (await hub.handle(pairStatusReq(), fakeServer))!.json()).status).toBe("none");
    const mint = await (await hub.handle(pairNewReq(), fakeServer))!.json();
    expect((await (await hub.handle(pairStatusReq(), fakeServer))!.json()).status).toBe("pending");
    await hub.handle(pairReq({ code: mint.code }), fakeServer);
    expect((await (await hub.handle(pairStatusReq(), fakeServer))!.json()).status).toBe("redeemed");
  });

  test("status from a LAN peer is 403 even with a valid bearer", async () => {
    const hub = pairHub(TOKEN, "0.0.0.0");
    const res = (await hub.handle(lanReq("/pair/status", { bearer: TOKEN }), lan))!;
    expect(res.status).toBe(403);
  });
});

describe("lanIPv4", () => {
  test("returns a dotted IPv4 or null, and never throws", () => {
    const ip = lanIPv4();
    expect(ip === null || /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)).toBe(true);
  });
});

describe("sweeps", () => {
  test("expiry ends stale sessions through the normal ingest path", async () => {
    const { hub, dir } = newHub();
    track(hub);
    const old = wireEvent("stale", ev.Done);
    old.ts = "2020-01-01T00:00:00Z";
    await post(hub, old);
    await post(hub, wireEvent("fresh", ev.Done));
    hub.startExpiry(60 * 60 * 1000, 24 * 60 * 60 * 1000); // sweeps once immediately
    const doc = await getState(hub);
    expect(doc.sessions.map((s) => s.session_key)).toEqual(["fresh"]);
    // The synthetic ended persisted like a real event.
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain('"expired"');
  });

  test("liveness ends sessions whose process died", async () => {
    const { hub } = newHub();
    track(hub);
    // A dead pid on our own host.
    const dead = wireEvent("dead", ev.Busy, { proc: { pid: 999999 } });
    dead.host = ev.shortHostname();
    await post(hub, dead);
    // A live pid (ourselves).
    const alive = wireEvent("alive", ev.Busy, { proc: { pid: process.pid } });
    alive.host = ev.shortHostname();
    await post(hub, alive);
    // A dead pid on another host: never swept from here.
    const remote = wireEvent("remote", ev.Busy, { proc: { pid: 999999 } });
    remote.host = "some-other-host";
    await post(hub, remote);

    hub.startLiveness(60 * 60 * 1000); // sweeps once immediately
    const keySet = (await getState(hub)).sessions.map((s) => s.session_key).sort();
    expect(keySet).toEqual(["alive", "remote"]);
  });

  test("liveness detects a recycled pid via comm mismatch", async () => {
    const { hub } = newHub();
    track(hub);
    const recycled = wireEvent("recycled", ev.Busy, {
      proc: { pid: process.pid, name: "definitely-not-this-process" },
    });
    recycled.host = ev.shortHostname();
    await post(hub, recycled);
    hub.startLiveness(60 * 60 * 1000);
    expect((await getState(hub)).sessions.length).toBe(0);
  });
});
