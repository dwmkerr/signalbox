import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, isLoopbackHost } from "../src/hub";
import * as ev from "../src/event";
import type { Event } from "../src/event";

// A fake Bun server: hub.handle only calls timeout() on it.
const fakeServer = { timeout() {} } as unknown as Bun.Server<undefined>;

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

  test("POST strips client-supplied acked/hidden/engaged_ts", async () => {
    const { hub } = newHub();
    track(hub);
    await post(hub, wireEvent("a", ev.Done, { acked: true, hidden: true, engaged_ts: "2030-01-01T00:00:00Z" }));
    const row = (await getState(hub)).sessions[0];
    expect(row.acked).toBeUndefined();
    expect(row.hidden).toBeUndefined();
    expect(row.engaged_ts).not.toBe("2030-01-01T00:00:00Z");
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
