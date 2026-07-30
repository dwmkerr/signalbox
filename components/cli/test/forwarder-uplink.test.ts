import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "../src/command";
import type { Event, StateDoc } from "../src/event";
import { Forwarder } from "../src/forwarder";
import { Hub, listen } from "../src/hub";

const TOKEN = "forwarder-test-token";

interface ReceivedEvent {
  body: Event;
  authorization: string | null;
  contentType: string | null;
}

interface ForwarderHealth {
  ok: boolean;
  version: string;
  upstream: {
    url: string;
    connected: boolean;
    lastSeq: number;
    spooled: number;
  };
}

interface SSEFrame {
  event: string;
  data: unknown;
}

class FakeUpstream {
  readonly received: ReceivedEvent[] = [];
  readonly server: Bun.Server<undefined>;
  readonly url: string;
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private enc = new TextEncoder();

  constructor(port = 0) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (req) => this.handle(req),
    });
    this.url = `http://127.0.0.1:${listenerPort(this.server)}`;
  }

  pushSignal(e: Event): void {
    this.push("signal", e);
  }

  pushCommand(c: Command): void {
    this.push("command", c);
  }

  async stop(): Promise<void> {
    for (const stream of this.streams) {
      try {
        stream.close();
      } catch {}
    }
    this.streams.clear();
    await stopServer(this.server);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/events") {
      this.received.push({
        body: (await req.json()) as Event,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
      });
      return Response.json({ seq: this.received.length });
    }
    if (req.method === "GET" && url.pathname === "/stream") {
      let current: ReadableStreamDefaultController<Uint8Array> | null = null;
      const streams = this.streams;
      const connected = this.enc.encode(": connected\n\n");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          current = controller;
          streams.add(controller);
          controller.enqueue(connected);
        },
        cancel() {
          if (current) streams.delete(current);
        },
      });
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private push(label: string, payload: unknown): void {
    const frame = this.enc.encode(`event: ${label}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const stream of this.streams) {
      try {
        stream.enqueue(frame);
      } catch {
        this.streams.delete(stream);
      }
    }
  }
}

let forwarders: Forwarder[] = [];
let fakeUpstreams: FakeUpstream[] = [];
let servers: Bun.Server<undefined>[] = [];
let hubs: Hub[] = [];

afterEach(async () => {
  for (const forwarder of forwarders) forwarder.close();
  for (const fake of fakeUpstreams) await fake.stop();
  for (const server of servers) await stopServer(server);
  for (const hub of hubs) hub.close();
  forwarders = [];
  fakeUpstreams = [];
  servers = [];
  hubs = [];
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function trackFake(fake: FakeUpstream): FakeUpstream {
  fakeUpstreams.push(fake);
  return fake;
}

function trackServer(server: Bun.Server<undefined>): Bun.Server<undefined> {
  servers.push(server);
  return server;
}

function trackHub(hub: Hub): Hub {
  hubs.push(hub);
  return hub;
}

function closeTrackedHub(hub: Hub): void {
  hub.close();
  const index = hubs.indexOf(hub);
  if (index >= 0) hubs.splice(index, 1);
}

function startForwarder(upstream: string): {
  forwarder: Forwarder;
  dir: string;
  server: Bun.Server<undefined>;
  url: string;
} {
  const dir = tempDir("sbforwarder-uplink-");
  const forwarder = new Forwarder({ upstream, token: TOKEN, stateDir: dir, version: "test" });
  const server = trackServer(listen(forwarder, 0));
  forwarders.push(forwarder);
  forwarder.start();
  return { forwarder, dir, server, url: `http://127.0.0.1:${listenerPort(server)}` };
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

async function postJSON(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getState(url: string): Promise<StateDoc> {
  const res = await fetch(`${url}/state`);
  expect(res.status).toBe(200);
  return res.json() as Promise<StateDoc>;
}

async function getHealth(url: string): Promise<ForwarderHealth> {
  const res = await fetch(`${url}/healthz`);
  expect(res.status).toBe(200);
  return res.json() as Promise<ForwarderHealth>;
}

async function waitFor(
  description: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function waitForConnection(url: string, connected: boolean, timeoutMs = 3000): Promise<void> {
  await waitFor(`forwarder connected=${connected}`, async () => {
    return (await getHealth(url)).upstream.connected === connected;
  }, timeoutMs);
}

async function stopServer(server: Bun.Server<undefined>): Promise<void> {
  try {
    await server.stop(true);
  } catch {}
}

function listenerPort(server: Bun.Server<undefined>): number {
  const port = server.port;
  if (port === undefined) throw new Error("listener did not expose a port");
  return port;
}

async function unusedPort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = listenerPort(reservation);
  await reservation.stop(true);
  return port;
}

function readSpool(path: string): Event[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);
}

async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs = 3000
): Promise<SSEFrame[]> {
  const frames: SSEFrame[] = [];
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffered = "";
  while (frames.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${count} SSE frames`);
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => {
        throw new Error(`timed out waiting for ${count} SSE frames`);
      }),
    ]);
    if (result.done) throw new Error(`stream ended after ${frames.length} of ${count} SSE frames`);
    buffered += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary < 0) break;
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      let label = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) label = line.slice("event:".length).trim();
        if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
      }
      if (data.length > 0) frames.push({ event: label, data: JSON.parse(data.join("\n")) });
    }
  }
  return frames.slice(0, count);
}

describe("forwarder uplink", () => {
  test("forwards with the token, oldest-first", async () => {
    const upstream = trackFake(new FakeUpstream());
    const { dir, url } = startForwarder(upstream.url);
    const events = [wireEvent("script:a"), wireEvent("script:b"), wireEvent("script:c")];

    for (const event of events) {
      const res = await postJSON(url, "/events", event);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ spooled: true });
    }

    const spoolPath = join(dir, "forward-spool.jsonl");
    await waitFor("the forward spool to drain", () => {
      return upstream.received.length === 3 && !existsSync(spoolPath);
    });
    expect(upstream.received.map((received) => received.body.session_key)).toEqual([
      "script:a",
      "script:b",
      "script:c",
    ]);
    for (const received of upstream.received) {
      expect(received.authorization).toBe(`Bearer ${TOKEN}`);
      expect(received.contentType).toBe("application/json");
    }
  });

  test("spools while the upstream is down and drains on recovery", async () => {
    const port = await unusedPort();
    const upstreamURL = `http://127.0.0.1:${port}`;
    const { dir, url } = startForwarder(upstreamURL);
    const events = [wireEvent("script:a"), wireEvent("script:b")];

    for (const event of events) {
      expect((await postJSON(url, "/events", event)).status).toBe(202);
    }

    const spoolPath = join(dir, "forward-spool.jsonl");
    await waitFor("two events to remain spooled", async () => {
      if (!existsSync(spoolPath)) return false;
      const health = await getHealth(url);
      return readSpool(spoolPath).length === 2 && !health.upstream.connected && health.upstream.spooled === 2;
    });
    expect(readSpool(spoolPath).map((event) => event.session_key)).toEqual(["script:a", "script:b"]);

    const upstream = trackFake(new FakeUpstream(port));
    await waitFor("recovered upstream to receive the spool", () => {
      return upstream.received.length === 2 && !existsSync(spoolPath);
    });
    expect(upstream.received.map((received) => received.body.session_key)).toEqual(["script:a", "script:b"]);
  });

  test("downlink feeds state and preserves it while the uplink is down", async () => {
    const upstream = trackFake(new FakeUpstream());
    const { url } = startForwarder(upstream.url);
    await waitForConnection(url, true);

    upstream.pushSignal(wireEvent("script:a", { seq: 4 }));
    upstream.pushSignal(wireEvent("script:b", { seq: 5 }));
    await waitFor("downlink state through seq 5", async () => {
      const [state, health] = await Promise.all([getState(url), getHealth(url)]);
      return state.sessions.length === 2 && health.upstream.lastSeq === 5;
    });
    expect((await getState(url)).sessions.map((event) => event.session_key).sort()).toEqual([
      "script:a",
      "script:b",
    ]);

    await upstream.stop();
    await waitForConnection(url, false);
    expect((await getState(url)).sessions.map((event) => event.session_key).sort()).toEqual([
      "script:a",
      "script:b",
    ]);
  });

  test("re-broadcasts signal and command frames", async () => {
    const upstream = trackFake(new FakeUpstream());
    const { url } = startForwarder(upstream.url);
    await waitForConnection(url, true);

    const res = await fetch(`${url}/stream?since=0`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const signal = wireEvent("script:menu", { seq: 1 });
    const command = wireCommand("script:menu");
    try {
      // The menu bar executor distinguishes these labels on this one stream,
      // so changing their names or order would stop local jumps from working.
      upstream.pushSignal(signal);
      upstream.pushCommand(command);
      const frames = await readFrames(reader, 2);
      expect(frames).toEqual([
        { event: "signal", data: signal },
        { event: "command", data: command },
      ]);
    } finally {
      await reader.cancel();
    }
  });

  test("replays later signal frames from the ring", async () => {
    const upstream = trackFake(new FakeUpstream());
    const { url } = startForwarder(upstream.url);
    await waitForConnection(url, true);

    upstream.pushSignal(wireEvent("script:a", { seq: 10 }));
    upstream.pushSignal(wireEvent("script:b", { seq: 11 }));
    upstream.pushSignal(wireEvent("script:c", { seq: 12 }));
    await waitFor("three downlink frames", async () => (await getHealth(url)).upstream.lastSeq === 12);

    const res = await fetch(`${url}/stream?since=10`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const frames = await readFrames(reader, 2);
      expect(frames.map((frame) => frame.event)).toEqual(["signal", "signal"]);
      expect(frames.map((frame) => (frame.data as Event).session_key)).toEqual(["script:b", "script:c"]);
    } finally {
      await reader.cancel();
    }
  });

  test("commands are never spooled", async () => {
    const port = await unusedPort();
    const { dir, url } = startForwarder(`http://127.0.0.1:${port}`);

    const res = await postJSON(url, "/command", wireCommand("script:command"));
    expect(res.status).toBe(502);
    expect(existsSync(join(dir, "forward-spool.jsonl"))).toBe(false);
  });

  test("loses no events across an upstream restart", async () => {
    const hubDir = tempDir("sbhub-uplink-");
    const firstHub = trackHub(new Hub(hubDir, "test", TOKEN, "0.0.0.0"));
    const firstServer = trackServer(listen(firstHub, 0));
    const port = listenerPort(firstServer);
    const upstreamURL = `http://127.0.0.1:${port}`;
    const { dir, url } = startForwarder(upstreamURL);
    await waitForConnection(url, true, 20_000);

    expect((await postJSON(url, "/events", wireEvent("script:a"))).status).toBe(202);
    await waitFor("event A to reach both hub and cache", async () => {
      const [hubState, forwarderState] = await Promise.all([getState(upstreamURL), getState(url)]);
      return hubState.sessions.length === 1 && forwarderState.sessions.length === 1;
    });

    await stopServer(firstServer);
    closeTrackedHub(firstHub);
    await waitForConnection(url, false, 20_000);

    expect((await postJSON(url, "/events", wireEvent("script:b"))).status).toBe(202);
    expect((await postJSON(url, "/events", wireEvent("script:c"))).status).toBe(202);
    const spoolPath = join(dir, "forward-spool.jsonl");
    await waitFor("events B and C to remain spooled", () => {
      return existsSync(spoolPath) && readSpool(spoolPath).length === 2;
    });
    expect(readSpool(spoolPath).map((event) => event.session_key)).toEqual(["script:b", "script:c"]);

    const secondHub = trackHub(new Hub(hubDir, "test", TOKEN, "0.0.0.0"));
    trackServer(listen(secondHub, port));
    await waitFor("restart replay and drain to converge", async () => {
      const [hubState, forwarderState, health] = await Promise.all([
        getState(upstreamURL),
        getState(url),
        getHealth(url),
      ]);
      return (
        hubState.sessions.length === 3 &&
        forwarderState.sessions.length === 3 &&
        health.upstream.lastSeq === 3 &&
        !existsSync(spoolPath)
      );
    }, 20_000);

    const persisted = readFileSync(join(hubDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Event);
    expect(persisted.map((event) => event.session_key)).toEqual(["script:a", "script:b", "script:c"]);
    expect(persisted.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((await getState(url)).sessions.map((event) => event.session_key).sort()).toEqual([
      "script:a",
      "script:b",
      "script:c",
    ]);
  }, 40_000);
});
