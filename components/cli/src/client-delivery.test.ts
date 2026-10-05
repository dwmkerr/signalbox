import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "./client";
import { newSeen } from "./event";

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

describe("client delivery boundary", () => {
  test("durably appends an event before its first POST", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbclient-boundary-"));
    let queuedAtPost = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        queuedAtPost = existsSync(join(dir, "spool.jsonl"));
        return Response.json({ seq: 1 });
      },
    });
    stop = () => server.stop(true);
    const client = new Client(`http://127.0.0.1:${server.port}`, dir);

    await client.deliver(newSeen("claude:boundary"));

    expect(queuedAtPost).toBe(true);
    expect(existsSync(join(dir, "spool.jsonl"))).toBe(false);
  });
});
