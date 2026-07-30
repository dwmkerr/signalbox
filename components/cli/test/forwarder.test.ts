import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "../src/command";
import type { Event } from "../src/event";
import { Forwarder } from "../src/forwarder";

function serverFrom(address: string): Bun.Server<undefined> {
  return {
    timeout() {},
    requestIP: () => ({ address, family: "IPv4", port: 54321 }),
  } as unknown as Bun.Server<undefined>;
}
const fakeServer = serverFrom("127.0.0.1");

const upstream = "http://127.0.0.1:1";

function newForwarder(): { forwarder: Forwarder; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sbforwarder-"));
  const forwarder = track(new Forwarder({ upstream, token: "test-token", stateDir: dir, version: "test" }));
  return { forwarder, dir };
}

function wireEvent(key: string, extra: Partial<Event> = {}): Event {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: "2026-07-29T10:00:00Z",
    host: "host",
    machine: "host-123abc",
    agent: "script",
    event: "done",
    session_key: key,
    ...extra,
  };
}

function wireCommand(key: string): Command {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: "2026-07-29T10:00:00Z",
    command: "jump",
    session_key: key,
    target_host: "host",
    host: "phone",
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Host")) headers.set("Host", "127.0.0.1:8377");
  return new Request(`http://127.0.0.1:8377${path}`, { ...init, headers });
}

async function postJSON(forwarder: Forwarder, path: string, body: unknown): Promise<Response> {
  return (await forwarder.handle(
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    fakeServer
  ))!;
}

let forwarders: Forwarder[] = [];
afterEach(() => {
  for (const forwarder of forwarders) forwarder.close();
  forwarders = [];
});

function track(forwarder: Forwarder): Forwarder {
  forwarders.push(forwarder);
  return forwarder;
}

describe("forwarder routes", () => {
  test("health reports upstream status", async () => {
    const { forwarder } = newForwarder();
    const res = (await forwarder.handle(request("/healthz"), fakeServer))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: "test",
      upstream: { url: upstream, connected: false, lastSeq: 0, spooled: 0 },
    });
  });

  test("rejects a non-loopback Host", async () => {
    const { forwarder } = newForwarder();
    const res = (await forwarder.handle(
      request("/state", { headers: { Host: "evil.example.com" } }),
      fakeServer
    ))!;
    expect(res.status).toBe(403);
  });

  test("POST /events appends one event and returns immediately", async () => {
    const { forwarder, dir } = newForwarder();
    const event = wireEvent("script:one");
    const res = await postJSON(forwarder, "/events", event);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ spooled: true });
    const lines = readFileSync(join(dir, "forward-spool.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(event);
  });

  test("local POST does not echo into state", async () => {
    const { forwarder } = newForwarder();
    await postJSON(forwarder, "/events", wireEvent("script:echo"));
    const state = (await forwarder.handle(request("/state"), fakeServer))!;
    // State is fed exclusively by the downlink, so the upstream echo applies once.
    expect(await state.json()).toEqual({ sessions: [] });
  });

  test("POST /events validates content type, JSON, and event shape", async () => {
    const { forwarder } = newForwarder();
    const text = (await forwarder.handle(
      request("/events", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(wireEvent("script:text")),
      }),
      fakeServer
    ))!;
    expect(text.status).toBe(415);

    const invalidJSON = (await forwarder.handle(
      request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
      fakeServer
    ))!;
    expect(invalidJSON.status).toBe(400);

    const missingKey = { ...wireEvent("script:missing") } as Partial<Event>;
    delete missingKey.session_key;
    const invalidEvent = await postJSON(forwarder, "/events", missingKey);
    expect(invalidEvent.status).toBe(400);
    expect((await invalidEvent.json()).error).toContain("session_key");
  });

  test("POST /events strips seq and reducer-derived fields", async () => {
    const { forwarder, dir } = newForwarder();
    await postJSON(forwarder, "/events", wireEvent("script:derived", {
      seq: 99,
      acked: true,
      hidden: true,
      pinned: true,
      engaged_ts: "2030-01-01T00:00:00Z",
    }));
    const spooled = JSON.parse(readFileSync(join(dir, "forward-spool.jsonl"), "utf8").trim());
    expect(spooled.seq).toBeUndefined();
    expect(spooled.acked).toBeUndefined();
    expect(spooled.hidden).toBeUndefined();
    expect(spooled.pinned).toBeUndefined();
    expect(spooled.engaged_ts).toBeUndefined();
  });

  test("POST /command reports an unreachable upstream and never spools", async () => {
    const { forwarder, dir } = newForwarder();
    const res = await postJSON(forwarder, "/command", wireCommand("script:command"));
    expect(res.status).toBe(502);
    expect(existsSync(join(dir, "forward-spool.jsonl"))).toBe(false);
  });

  for (const [method, path] of [
    ["POST", "/pair/new"],
    ["GET", "/pair/status"],
    ["POST", "/pair"],
  ] as const) {
    test(`${method} ${path} refuses pairing`, async () => {
      const { forwarder } = newForwarder();
      const res = (await forwarder.handle(request(path, { method }), fakeServer))!;
      expect(res.status).toBe(409);
      const body = await res.text();
      expect(body).toContain("signalbox pair --url");
      expect(body).toContain(upstream);
    });
  }

  test("GET /stream rejects a non-numeric since", async () => {
    const { forwarder } = newForwarder();
    const res = (await forwarder.handle(request("/stream?since=notanumber"), fakeServer))!;
    expect(res.status).toBe(400);
  });

  test("never creates an event log", async () => {
    const { forwarder, dir } = newForwarder();
    await postJSON(forwarder, "/events", wireEvent("script:no-log"));
    await forwarder.handle(request("/state"), fakeServer);
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
  });
});
