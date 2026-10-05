import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "./event";
import { Busy, Done, Version } from "./event";
import { Forwarder } from "./forwarder";
import { Hub, listen } from "./hub";
import { acquireLock, Spool } from "./spool";
import { drainStartupSpool } from "./startup";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sbstartup-"));
}

function event(id: string, type: string): Event {
  return {
    v: Version,
    id,
    ts: "2026-08-25T10:00:00Z",
    host: "test-host",
    machine: "test-machine",
    agent: "claude",
    event: type,
    session_key: "claude:restart",
  };
}

describe("startup spool", () => {
  test("folds the complete backlog before state becomes ready", async () => {
    const dir = tempDir();
    const spool = new Spool(dir, "spool.jsonl");
    await spool.append(JSON.stringify(event("busy", Busy)));
    await spool.append(JSON.stringify(event("done", Done)));
    const hub = new Hub(dir, "test");
    let stateAtReady: Event[] = [];

    try {
      const ingested = await drainStartupSpool(
        dir,
        (queued) => { hub.ingest(queued); },
        () => { stateAtReady = hub.sessions(); }
      );

      expect(ingested).toBe(2);
      expect(stateAtReady).toHaveLength(1);
      expect(stateAtReady[0].event).toBe(Done);
      expect(stateAtReady[0].seq).toBe(2);
      expect(existsSync(spool.path())).toBe(false);
    } finally {
      hub.close();
    }
  });

  test("includes an event appended while the backlog is being consumed", async () => {
    const dir = tempDir();
    const startup = new Spool(dir, "spool.jsonl");
    const hook = new Spool(dir, "spool.jsonl");
    await startup.append("first");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let consuming!: () => void;
    const consumeStarted = new Promise<void>((resolve) => { consuming = resolve; });
    const consumed: string[] = [];
    let ready = false;

    const draining = startup.drainBeforeReady(async (line) => {
      consumed.push(line);
      if (line === "first") {
        consuming();
        await blocked;
      }
    }, () => { ready = true; });

    await consumeStarted;
    await hook.append("second");
    expect(ready).toBe(false);
    release();

    expect(await draining).toBe(2);
    expect(consumed).toEqual(["first", "second"]);
    expect(ready).toBe(true);
  });

  test("holds the append boundary across the ready callback", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    let appendLockHeld = false;

    await spool.drainBeforeReady(async () => {}, () => {
      const unlock = acquireLock(spool.path() + ".lock");
      appendLockHeld = unlock === null;
      unlock?.();
    });

    expect(appendLockHeld).toBe(true);
    const unlock = acquireLock(spool.path() + ".lock");
    expect(unlock).not.toBeNull();
    unlock?.();
  });

  test("does not become ready when persistence fails", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    await spool.append("first");
    await spool.append("second");
    let ready = false;

    await expect(spool.drainBeforeReady(async (line) => {
      if (line === "second") throw new Error("disk unavailable");
    }, () => { ready = true; })).rejects.toThrow("disk unavailable");

    expect(ready).toBe(false);
    expect(readFileSync(spool.path(), "utf8").trim()).toBe("second");
  });

  test("moves the hook backlog into the forwarder's outbound spool", async () => {
    const dir = tempDir();
    const source = new Spool(dir, "spool.jsonl");
    const queued = event("forward", Done);
    await source.append(JSON.stringify(queued));
    const forwarder = new Forwarder({
      upstream: "http://127.0.0.1:1",
      token: "",
      stateDir: dir,
      version: "test",
      port: 8377,
      historyLimit: 10,
    });
    let outboundAtReady: Event[] = [];

    try {
      await drainStartupSpool(dir, (item) => forwarder.enqueue(item), () => {
        outboundAtReady = readFileSync(join(dir, "forward-spool.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Event);
      });

      expect(outboundAtReady.map((item) => item.id)).toEqual([queued.id]);
      expect(existsSync(source.path())).toBe(false);
    } finally {
      forwarder.close();
    }
  });

  test("waits for upstream replay and queued-event echo before forwarder readiness", async () => {
    const upstreamDir = tempDir();
    const forwarderDir = tempDir();
    const upstream = new Hub(upstreamDir, "test");
    upstream.ingest(event("remote-done", Done));
    const upstreamServer = listen(upstream, 0);
    const source = new Spool(forwarderDir, "spool.jsonl");
    await source.append(JSON.stringify(event("offline-busy", Busy)));
    const forwarder = new Forwarder({
      upstream: `http://127.0.0.1:${upstreamServer.port}`,
      token: "",
      stateDir: forwarderDir,
      version: "test",
      port: 8377,
      historyLimit: 10,
    });
    let stateAtReady: Response | undefined;

    try {
      await drainStartupSpool(
        forwarderDir,
        (item) => forwarder.enqueue(item),
        () => {
          stateAtReady = forwarder.handle(
            new Request("http://127.0.0.1/state", { headers: { Host: "127.0.0.1" } }),
            upstreamServer
          ) as Response;
        },
        () => {},
        () => forwarder.synchronize()
      );

      const state = await stateAtReady!.json() as { sessions: Event[] };
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].id).toBe("offline-busy");
      expect(state.sessions[0].event).toBe(Busy);
      expect(existsSync(source.path())).toBe(false);
      expect(existsSync(join(forwarderDir, "forward-spool.jsonl"))).toBe(false);
    } finally {
      forwarder.close();
      upstreamServer.stop(true);
      upstream.close();
    }
  });

  test("uses a legacy upstream heartbeat as the replay boundary", async () => {
    const queued = { ...event("legacy", Done), seq: 7 };
    const encoder = new TextEncoder();
    const upstreamServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: signal\ndata: ${JSON.stringify(queued)}\n\n: heartbeat\n\n`
          ));
        },
      }), { headers: { "Content-Type": "text/event-stream" } }),
    });
    const forwarder = new Forwarder({
      upstream: `http://127.0.0.1:${upstreamServer.port}`,
      token: "",
      stateDir: tempDir(),
      version: "test",
      port: 8377,
      historyLimit: 10,
    });

    try {
      await forwarder.synchronize();
      const state = forwarder.handle(
        new Request("http://127.0.0.1/state", { headers: { Host: "127.0.0.1" } }),
        upstreamServer
      ) as Response;
      expect((await state.json() as { sessions: Event[] }).sessions[0].id).toBe("legacy");
    } finally {
      forwarder.close();
      upstreamServer.stop(true);
    }
  });
});
