import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../src/client";
import * as ev from "../src/event";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sbclient-"));
}

// A tiny scriptable hub: each request is answered per the handler.
function testHub(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

describe("deliver", () => {
  test("spools on a dead port", async () => {
    const dir = tempDir();
    const c = new Client("http://127.0.0.1:1", dir);
    await expect(c.deliver(ev.newSeen("claude:x"))).rejects.toThrow();
    const spool = readFileSync(join(dir, "spool.jsonl"), "utf8").trim().split("\n");
    expect(spool.length).toBe(1);
    expect(JSON.parse(spool[0]).session_key).toBe("claude:x");
  });

  test("drains the spool before the new event, oldest first", async () => {
    const received: string[] = [];
    const hub = testHub(async (req) => {
      const e = await req.json();
      received.push(e.session_key);
      return Response.json({ seq: received.length });
    });
    stops.push(hub.stop);
    const dir = tempDir();
    // Pre-spool two events.
    const a = ev.newSeen("claude:a");
    const b = ev.newSeen("claude:b");
    writeFileSync(join(dir, "spool.jsonl"), JSON.stringify(a) + "\n" + JSON.stringify(b) + "\n");
    const c = new Client(hub.url, dir);
    await c.deliver(ev.newSeen("claude:c"));
    expect(received).toEqual(["claude:a", "claude:b", "claude:c"]);
    expect(existsSync(join(dir, "spool.jsonl"))).toBe(false);
  });

  test("drain drops events the hub rejects with 4xx", async () => {
    const received: string[] = [];
    const hub = testHub(async (req) => {
      const e = await req.json();
      if (e.session_key === "claude:poison") {
        return Response.json({ error: "no" }, { status: 400 });
      }
      received.push(e.session_key);
      return Response.json({ seq: 1 });
    });
    stops.push(hub.stop);
    const dir = tempDir();
    writeFileSync(
      join(dir, "spool.jsonl"),
      JSON.stringify(ev.newSeen("claude:poison")) + "\n" + JSON.stringify(ev.newSeen("claude:good")) + "\n"
    );
    const c = new Client(hub.url, dir);
    const sent = await c.drain();
    expect(sent).toBe(1);
    expect(received).toEqual(["claude:good"]);
    expect(existsSync(join(dir, "spool.jsonl"))).toBe(false);
  });

  test("drain stops at a transient failure and keeps the remainder", async () => {
    let count = 0;
    const hub = testHub(async () => {
      count++;
      if (count >= 2) return Response.json({ error: "down" }, { status: 500 });
      return Response.json({ seq: count });
    });
    stops.push(hub.stop);
    const dir = tempDir();
    writeFileSync(
      join(dir, "spool.jsonl"),
      [ev.newSeen("claude:1"), ev.newSeen("claude:2"), ev.newSeen("claude:3")]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n"
    );
    const c = new Client(hub.url, dir);
    await expect(c.drain()).rejects.toThrow();
    const kept = readFileSync(join(dir, "spool.jsonl"), "utf8").trim().split("\n");
    // First delivered; second failed transiently and is kept with the third.
    expect(kept.length).toBe(2);
    expect(JSON.parse(kept[0]).session_key).toBe("claude:2");
  });
});
